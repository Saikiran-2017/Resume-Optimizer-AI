// =====================================================
// BACKGROUND SERVICE WORKER
// Opens popup as a persistent floating window
// that does NOT close when user clicks outside
// =====================================================

let popupWindowId = null;

chrome.action.onClicked.addListener(async (tab) => {
  // If window already open, just focus it
  if (popupWindowId !== null) {
    try {
      await chrome.windows.update(popupWindowId, { focused: true });
      return;
    } catch (e) {
      // Window was closed externally — reset and open fresh
      popupWindowId = null;
    }
  }

  // Get screen dimensions to position window nicely (top-right corner)
  const screen = await chrome.system?.display?.getInfo?.().catch(() => null);
  let left = 1400;
  let top  = 60;

  // Try to position near top-right of current window
  try {
    const currentWin = await chrome.windows.getCurrent();
    left = (currentWin.left + currentWin.width) - 480;
    top  = currentWin.top + 60;
  } catch (e) {}

  const win = await chrome.windows.create({
    url:    chrome.runtime.getURL('popup.html'),
    type:   'normal',        // normal window — never auto-closes on outside click
    width:  470,
    height: 680,
    left:   Math.max(0, left),
    top:    Math.max(0, top),
    focused: true
  });

  popupWindowId = win.id;
});

// Reset tracking when window is closed
chrome.windows.onRemoved.addListener((windowId) => {
  if (windowId === popupWindowId) {
    popupWindowId = null;
  }
});
