'use strict';

const title = document.getElementById('popup-title');
const openButton = document.getElementById('open-browser');
let opening = false;
let canOpen = false;

function update(state) {
  if (!state) return;
  title.textContent = state.title;
  title.title = state.url || state.title;
  document.body.classList.toggle('mac', state.platform === 'darwin');
  canOpen = state.canOpen;
  openButton.disabled = opening || !canOpen;
}

window.popup.onState(update);
window.popup.getState().then(update);
openButton.addEventListener('click', async () => {
  if (opening || !canOpen) return;
  opening = true;
  openButton.disabled = true;
  try {
    const result = await window.popup.openExternal();
    if (!result.ok) window.alert(result.error);
  } catch {
    window.alert('无法打开系统浏览器，请重试');
  } finally {
    opening = false;
    openButton.disabled = !canOpen;
  }
});
document.getElementById('close-popup').addEventListener('click', () => window.popup.close());
