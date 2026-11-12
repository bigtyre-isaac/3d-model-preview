const accountLink = document.getElementById('account-link');
const uploadLink = document.getElementById('upload-link');
const logoutButton = document.getElementById('logout');
const modelBrowser = document.getElementById('model-browser');
const listStatus = document.getElementById('model-list-status');

/** Load viewer links through the protected index, never through public directory browsing. */
async function loadModels() {
  const response = await fetch('/api/models');
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || 'Unable to load models.');
  }

  const list = document.getElementById('model-list');
  list.replaceChildren();
  for (const model of result.models) {
    const link = document.createElement('a');
    link.textContent = model.filename;
    link.href = model.url;

    const item = document.createElement('li');
    item.append(link);
    list.append(item);
  }

  listStatus.textContent = result.models.length ? '' : 'No models uploaded yet.';
}

/** Reflect the browser session without making authentication a requirement for viewing. */
async function loadSession() {
  const response = await fetch('/api/me');
  if (!response.ok) {
    return;
  }

  const { user } = await response.json();
  accountLink.textContent = 'Accounts';
  logoutButton.hidden = false;
  uploadLink.hidden = !(user.roles.includes('admin') || user.roles.includes('upload-models'));

  const canListModels = user.roles.includes('admin') || user.roles.includes('list-models');
  if (!canListModels) {
    return;
  }

  const hasModel = new URLSearchParams(location.search).has('model');
  modelBrowser.hidden = false;
  modelBrowser.open = !hasModel;
  listStatus.textContent = 'Loading models…';
  try {
    await loadModels();
    if (!hasModel) {
      document.getElementById('status').textContent = '';
    }
  } catch (error) {
    listStatus.textContent = error.message;
  }
}

/** Clear the browser session and reload to remove private index content. */
async function logout() {
  logoutButton.disabled = true;
  try {
    const response = await fetch('/api/logout', { method: 'POST' });
    if (!response.ok) {
      const result = await response.json();
      throw new Error(result.error || 'Unable to log out.');
    }
    location.reload();
  } catch (error) {
    document.getElementById('status').textContent = error.message;
    logoutButton.disabled = false;
  }
}

logoutButton.addEventListener('click', logout);
loadSession().catch(() => {
  // Public viewing remains available if session lookup is temporarily unavailable.
});
