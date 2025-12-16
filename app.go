package main

import (
	"context"
	"errors"
	"fmt"
	"net"
	"strings"
	"sync"
	"time"

	"go.einride.tech/can"
	"go.einride.tech/can/pkg/socketcan"

	"github.com/wailsapp/wails/v2/pkg/runtime"
)

// App struct
type App struct {
	ctx context.Context

	mu      sync.Mutex
	session *canSession
}

type canSession struct {
	iface  string
	ctx    context.Context
	cancel context.CancelFunc
	conn   net.Conn
	rx     *socketcan.Receiver
	tx     *socketcan.Transmitter
	done   chan struct{}
}

// NewApp creates a new App application struct
func NewApp() *App {
	return &App{}
}

// startup is called when the app starts. The context is saved
// so we can call the runtime methods
func (a *App) startup(ctx context.Context) {
	a.ctx = ctx
}

func (a *App) shutdown(ctx context.Context) {
	_ = a.StopCAN()
}

type CANFrameEvent struct {
	Timestamp time.Time `json:"timestamp"`
	Interface string    `json:"interface"`
	ID        uint32    `json:"id"`
	Extended  bool      `json:"extended"`
	Remote    bool      `json:"remote"`
	DLC       uint8     `json:"dlc"`
	Data      []uint32  `json:"data"`
}

// StartCAN connects to a SocketCAN interface (eg: vcan0 or can0), starts a goroutine and emits frames via "can:frame".
func (a *App) StartCAN(iface string) error {
	iface = strings.TrimSpace(iface)
	if iface == "" {
		iface = "vcan0"
	}

	a.mu.Lock()
	if a.session != nil {
		a.mu.Unlock()
		return errors.New("CAN already started")
	}
	ctx, cancel := context.WithCancel(context.Background())
	sess := &canSession{
		iface:  iface,
		ctx:    ctx,
		cancel: cancel,
		done:   make(chan struct{}),
	}
	a.session = sess
	a.mu.Unlock()

	conn, err := socketcan.DialContext(ctx, "can", iface)
	if err != nil {
		if ctx.Err() == nil {
			a.emitError(fmt.Errorf("dial %s: %w", iface, err))
		}
		cancel()
		close(sess.done)
		a.mu.Lock()
		if a.session == sess {
			a.session = nil
		}
		a.mu.Unlock()
		return err
	}

	if ctx.Err() != nil {
		_ = conn.Close()
		cancel()
		close(sess.done)
		a.mu.Lock()
		if a.session == sess {
			a.session = nil
		}
		a.mu.Unlock()
		return ctx.Err()
	}

	a.mu.Lock()
	sess.conn = conn
	sess.rx = socketcan.NewReceiver(conn)
	sess.tx = socketcan.NewTransmitter(conn)
	a.mu.Unlock()

	go a.receiveLoop(sess)
	return nil
}

func (a *App) receiveLoop(sess *canSession) {
	defer func() {
		close(sess.done)
		if sess.conn != nil {
			_ = sess.conn.Close()
		}
		a.mu.Lock()
		if a.session == sess {
			a.session = nil
		}
		a.mu.Unlock()
	}()

	for sess.rx.Receive() {
		if sess.ctx.Err() != nil {
			return
		}

		if sess.rx.HasErrorFrame() {
			if sess.ctx.Err() == nil {
				ef := sess.rx.ErrorFrame()
				a.emitError(fmt.Errorf("CAN error frame: class=%s controller=%s protocol=%s location=%s transceiver=%s",
					ef.ErrorClass,
					ef.ControllerError,
					ef.ProtocolError,
					ef.ProtocolViolationErrorLocation,
					ef.TransceiverError,
				))
			}
			continue
		}

		f := sess.rx.Frame()
		data := make([]uint32, f.Length)
		for i := 0; i < int(f.Length); i++ {
			data[i] = uint32(f.Data[i])
		}

		runtime.EventsEmit(a.ctx, "can:frame", CANFrameEvent{
			Timestamp: time.Now(),
			Interface: sess.iface,
			ID:        f.ID,
			Extended:  f.IsExtended,
			Remote:    f.IsRemote,
			DLC:       f.Length,
			Data:      data,
		})
	}

	if err := sess.rx.Err(); err != nil && sess.ctx.Err() == nil && !errors.Is(err, net.ErrClosed) {
		a.emitError(fmt.Errorf("receive: %w", err))
	}
}

// StopCAN stops the receive goroutine and closes the SocketCAN connection.
func (a *App) StopCAN() error {
	a.mu.Lock()
	sess := a.session
	var cancel context.CancelFunc
	var conn net.Conn
	var done chan struct{}
	if sess != nil {
		cancel = sess.cancel
		conn = sess.conn
		done = sess.done
	}
	a.mu.Unlock()

	if sess == nil {
		return nil
	}

	if cancel != nil {
		cancel()
	}
	if conn != nil {
		_ = conn.Close()
	}
	<-done

	a.mu.Lock()
	if a.session == sess {
		a.session = nil
	}
	a.mu.Unlock()
	return nil
}

// SendFrame sends a CAN frame on the currently connected interface.
func (a *App) SendFrame(id uint32, data []byte, extended bool) error {
	if len(data) > 8 {
		return fmt.Errorf("data length must be <= 8 (got %d)", len(data))
	}

	a.mu.Lock()
	var tx *socketcan.Transmitter
	if a.session != nil {
		tx = a.session.tx
	}
	a.mu.Unlock()

	if tx == nil {
		return errors.New("CAN not started")
	}

	var d can.Data
	copy(d[:], data)
	f := can.Frame{
		ID:         id,
		Length:     uint8(len(data)),
		Data:       d,
		IsExtended: extended,
	}
	if err := f.Validate(); err != nil {
		return err
	}

	ctx, cancel := context.WithTimeout(context.Background(), 1*time.Second)
	defer cancel()
	if err := tx.TransmitFrame(ctx, f); err != nil {
		a.emitError(err)
		return err
	}
	return nil
}

func (a *App) emitError(err error) {
	if err == nil || a.ctx == nil {
		return
	}
	runtime.EventsEmit(a.ctx, "can:error", err.Error())
}
