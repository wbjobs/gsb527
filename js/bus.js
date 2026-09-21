/* 跨标签页事件总线：BroadcastChannel + 本页回调（Service Worker 消息也汇入同一总线） */
(function (global) {
  const CHANNEL = 'offline-forms-channel';
  const listeners = new Map();
  let channel = null;

  if ('BroadcastChannel' in global) {
    channel = new BroadcastChannel(CHANNEL);
    channel.onmessage = (event) => dispatch(event.data, true);
  }

  function dispatch(message, fromRemote) {
    if (!message || !message.type) return;
    const handlers = listeners.get(message.type);
    if (handlers) {
      handlers.forEach((handler) => {
        try {
          handler(message.payload || {}, { remote: Boolean(fromRemote), source: message.source });
        } catch (err) {
          console.error('[bus] handler error', message.type, err);
        }
      });
    }
    const wildcard = listeners.get('*');
    if (wildcard) wildcard.forEach((handler) => handler(message, { remote: Boolean(fromRemote) }));
  }

  function emit(type, payload) {
    const message = { type, payload, at: Date.now() };
    dispatch(message, false);
    if (channel) channel.postMessage(message);
  }

  function on(type, handler) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(handler);
    return () => listeners.get(type) && listeners.get(type).delete(handler);
  }

  // Service Worker -> 页面的消息（如离线 ACK）汇入总线
  if (navigator.serviceWorker) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type) dispatch(event.data, true);
    });
  }

  global.Bus = { emit, on };
})(window);
