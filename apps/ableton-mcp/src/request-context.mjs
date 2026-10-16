import { AsyncLocalStorage } from "node:async_hooks";

const requests = new AsyncLocalStorage();

export function requestSignal() {
  return requests.getStore();
}

export function withRequestSignal(signal, callback) {
  return requests.run(signal, callback);
}
