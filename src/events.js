'use strict';

/** Server-Sent Events hub for the admin dashboard. */
class EventHub {
  constructor() {
    this.clients = new Set();
    this._heartbeat = setInterval(() => {
      for (const res of this.clients) {
        try {
          res.write(': ping\n\n');
        } catch {
          this.clients.delete(res);
        }
      }
    }, 15_000);
    this._heartbeat.unref?.();
  }

  addClient(res) {
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  broadcast(event, data) {
    if (this.clients.size === 0) return;
    const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of this.clients) {
      try {
        res.write(frame);
      } catch {
        this.clients.delete(res);
      }
    }
  }

  close() {
    clearInterval(this._heartbeat);
    for (const res of this.clients) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
    }
    this.clients.clear();
  }
}

module.exports = { EventHub };
