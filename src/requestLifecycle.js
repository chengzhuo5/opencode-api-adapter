export function createClientDisconnectScope(req, res) {
  const controller = new AbortController();
  const abort = () => {
    if (controller.signal.aborted) return;
    const error = new Error('client disconnected');
    error.name = 'ClientDisconnectError';
    controller.abort(error);
  };
  const onResponseClose = () => {
    if (!res.writableEnded) abort();
  };
  const onSocketClose = () => {
    if (!res.writableEnded) abort();
  };
  req.once('aborted', abort);
  res.once('close', onResponseClose);
  req.socket?.once('close', onSocketClose);
  return {
    signal: controller.signal,
    dispose() {
      req.off('aborted', abort);
      res.off('close', onResponseClose);
      req.socket?.off('close', onSocketClose);
    }
  };
}

export function createAbortScope({ timeoutMs, parentSignal } = {}) {
  const controller = new AbortController();
  let timer = null;
  const onParentAbort = () => {
    if (!controller.signal.aborted) {
      controller.abort(parentSignal.reason || abortError('parent request aborted'));
    }
  };
  if (parentSignal?.aborted) {
    onParentAbort();
  } else {
    parentSignal?.addEventListener('abort', onParentAbort, { once: true });
  }
  if (!controller.signal.aborted && Number.isFinite(timeoutMs) && timeoutMs > 0) {
    timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      const error = new Error(`request timed out after ${timeoutMs} ms`);
      error.name = 'TimeoutError';
      controller.abort(error);
    }, timeoutMs);
    timer.unref?.();
  }
  return {
    signal: controller.signal,
    dispose() {
      if (timer) clearTimeout(timer);
      parentSignal?.removeEventListener('abort', onParentAbort);
    }
  };
}

export async function readWithAbort(reader, signal) {
  if (!signal) return reader.read();
  if (signal.aborted) {
    try { await reader.cancel(signal.reason); } catch { /* noop */ }
    throw signal.reason || abortError();
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      const reason = signal.reason || abortError();
      Promise.resolve(reader.cancel(reason)).catch(() => {});
      finish(reject, reason);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    reader.read().then(
      (value) => {
        if (signal.aborted) finish(reject, signal.reason || abortError());
        else finish(resolve, value);
      },
      (error) => finish(reject, error)
    );
  });
}

function abortError(message = 'operation aborted') {
  const error = new Error(message);
  error.name = 'AbortError';
  return error;
}
