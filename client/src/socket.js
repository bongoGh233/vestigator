import { io } from "socket.io-client";

export const socket = io({
  autoConnect: false,
});

export function connect() {
  socket.connect();
}

export function disconnect() {
  socket.disconnect();
}
