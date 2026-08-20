/** Relay PrivyDeck web app messages (same origin only). */
window.addEventListener("message", (event) => {
  if (event.source !== window) return;
  if (event.origin !== window.location.origin) return;

  if (event.data?.type === "PRIVYDECK_CONNECT") {
    chrome.runtime
      .sendMessage({
        type: "PRIVYDECK_SAVE",
        settings: {
          hubUrl: event.data.hubUrl,
          token: event.data.token,
          deviceName: event.data.deviceName,
          platform: event.data.platform,
        },
      })
      .then((res) => {
        window.postMessage(
          {
            type: "PRIVYDECK_CONNECT_RESULT",
            ok: Boolean(res?.ok),
            message: res?.ok ? "Extension connected and synced." : res?.error,
            error: res?.error,
          },
          window.location.origin
        );
      })
      .catch((err) => {
        window.postMessage(
          {
            type: "PRIVYDECK_CONNECT_RESULT",
            ok: false,
            error: String(err?.message || err),
          },
          window.location.origin
        );
      });
    return;
  }

  if (event.data?.type === "PRIVYDECK_RULES_CHANGED") {
    chrome.runtime
      .sendMessage({ type: "PRIVYDECK_SYNC" })
      .then((res) => {
        window.postMessage(
          {
            type: "PRIVYDECK_RULES_CHANGED_RESULT",
            ok: Boolean(res?.ok),
            error: res?.error,
          },
          window.location.origin
        );
      })
      .catch((err) => {
        window.postMessage(
          {
            type: "PRIVYDECK_RULES_CHANGED_RESULT",
            ok: false,
            error: String(err?.message || err),
          },
          window.location.origin
        );
      });
  }
});
