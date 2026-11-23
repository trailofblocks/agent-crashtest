import type net from "node:net";
import type { JSONRPCMessage, Transport } from "@modelcontextprotocol/server";

/** Newline-delimited JSON-RPC over a TCP socket. Process mode uses it between the agent and the harness. */
export class SocketTransport implements Transport {
  onmessage?: (message: JSONRPCMessage) => void;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  private buf: string;
  private closed = false;

  constructor(
    private readonly socket: net.Socket,
    /** Bytes already read from the socket (after a hello line). */
    initial = "",
  ) {
    this.buf = initial;
  }

  async start(): Promise<void> {
    this.socket.setEncoding("utf8");
    this.socket.on("data", (chunk: string) => {
      this.buf += chunk;
      this.drain();
    });
    this.socket.on("close", () => {
      if (this.closed) return;
      this.closed = true;
      this.onclose?.();
    });
    this.socket.on("error", (e) => this.onerror?.(e));
    this.socket.resume();
    this.drain();
  }

  private drain(): void {
    for (let i = this.buf.indexOf("\n"); i >= 0; i = this.buf.indexOf("\n")) {
      const line = this.buf.slice(0, i).replace(/\r$/, "");
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: JSONRPCMessage;
      try {
        msg = JSON.parse(line) as JSONRPCMessage;
      } catch (e) {
        this.onerror?.(e as Error);
        continue;
      }
      this.onmessage?.(msg);
    }
  }

  send(message: JSONRPCMessage): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.closed || this.socket.destroyed) return reject(new Error("socket closed"));
      this.socket.write(`${JSON.stringify(message)}\n`, (e) => (e ? reject(e) : resolve()));
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.onclose?.();
  }
}

/** Read one line from a socket, then pause it, so a transport can take over without losing bytes. */
export function readHello(socket: net.Socket): Promise<{ hello: string; rest: string }> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: Buffer | string) => {
      buf += chunk.toString();
      const i = buf.indexOf("\n");
      if (i < 0) return;
      socket.off("data", onData);
      socket.off("error", reject);
      socket.pause();
      resolve({ hello: buf.slice(0, i).trim(), rest: buf.slice(i + 1) });
    };
    socket.on("data", onData);
    socket.on("error", reject);
  });
}
