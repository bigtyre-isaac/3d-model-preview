const roles = ['list-models', 'upload-models', 'admin'];

/** Find a fixed page element by its ID. */
function element(id) {
  return document.getElementById(id);
}

/** Send an account API request and surface server errors to the caller. */
async function api(path, method = 'GET', data) {
  const response = await fetch('/api/' + path, {
    method,
    headers: data ? { 'Content-Type': 'application/json' } : {},
    body: data ? JSON.stringify(data) : undefined,
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error);
  }
  return result;
}

/** Render the shared role choices used by new and existing accounts. */
function renderRoleInputs(container, selectedRoles = []) {
  for (const role of roles) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.value = role;
    input.checked = selectedRoles.includes(role);

    const label = document.createElement('label');
    label.append(input, ' ' + role);
    container.append(label);
  }
}

/** Read the selected permissions from a role checkbox group. */
function selectedRoles(container) {
  return [...container.querySelectorAll('input:checked')].map(input => input.value);
}

/** Bind an async form action with consistent busy state and error reporting. */
function bindForm(form, callback) {
  const button = form.querySelector('button');
  const errorMessage = document.createElement('p');
  errorMessage.className = 'form-error';
  errorMessage.setAttribute('role', 'alert');
  button.after(errorMessage);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    button.disabled = true;
    errorMessage.textContent = '';
    element('status').textContent = '';

    try {
      await callback(Object.fromEntries(new FormData(form)));
    } catch (error) {
      errorMessage.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  });
}

/** Pair an input with a label without using HTML interpolation for account data. */
function labeledInput(text, input) {
  const label = document.createElement('label');
  label.append(text, input);
  return label;
}

/** Load and render public viewer links available to the signed-in account. */
async function refreshModels() {
  const { models } = await api('models');
  const list = element('modelList');
  list.replaceChildren();

  for (const model of models) {
    const link = document.createElement('a');
    link.textContent = model.filename;
    link.href = model.url;

    const item = document.createElement('li');
    item.append(link);
    list.append(item);
  }

  if (!models.length) {
    list.textContent = 'No models uploaded.';
  }
}

/** Build one account editor and bind its save operation. */
function createAccountForm(account, currentUser) {
  const form = document.createElement('form');
  const fieldset = document.createElement('fieldset');
  const legend = document.createElement('legend');
  legend.textContent = account.username;

  const permissions = document.createElement('div');
  renderRoleInputs(permissions, account.roles);

  const disabled = document.createElement('input');
  disabled.type = 'checkbox';
  disabled.checked = account.disabled;
  const disabledLabel = document.createElement('label');
  disabledLabel.append(disabled, ' Disabled');

  const password = document.createElement('input');
  password.type = 'password';
  password.autocomplete = 'new-password';
  password.minLength = 12;
  password.maxLength = 256;

  const button = document.createElement('button');
  button.textContent = 'Save account';
  fieldset.append(
    legend,
    permissions,
    disabledLabel,
    labeledInput('Reset password (leave empty to keep current)', password),
    button,
  );
  form.append(fieldset);

  bindForm(form, async () => {
    const changes = {
      roles: selectedRoles(permissions),
      disabled: disabled.checked,
    };
    if (password.value) {
      changes.password = password.value;
    }

    await api('users/' + account.id, 'PATCH', changes);
    if (account.id === currentUser.id) {
      // Saving our own account revokes the session used by this page.
      location.reload();
    } else {
      await refresh();
      element('status').textContent = 'Account saved. Existing sessions revoked.';
    }
  });

  return form;
}

/** Wrap an account editor in a compact, keyboard-accessible disclosure row. */
function createAccountRow(account, currentUser) {
  const row = document.createElement('details');
  row.className = 'account-row';
  row.name = 'account-editors';
  row.dataset.accountId = account.id;

  const summary = document.createElement('summary');
  const name = document.createElement('span');
  name.className = 'account-name';
  name.textContent = account.username;

  const description = document.createElement('span');
  description.className = 'account-description';
  description.textContent = account.roles.join(', ') || 'No roles';
  if (account.disabled) {
    description.textContent = 'Disabled · ' + description.textContent;
  }

  summary.append(name, description);
  row.append(summary, createAccountForm(account, currentUser));
  return row;
}

/** Reload account rows while preserving the editor currently being used. */
async function refreshAccounts(currentUser) {
  const { users } = await api('users');
  const container = element('users');
  const openAccountId = container.querySelector('details[open]')?.dataset.accountId;
  container.replaceChildren();

  for (const account of users) {
    const row = createAccountRow(account, currentUser);
    row.open = account.id === openAccountId;
    container.append(row);
  }
}

/** Show the current identity and load only the sections allowed by its roles. */
async function refresh() {
  const { user } = await api('me');
  const isAdmin = user.roles.includes('admin');
  const canListModels = isAdmin || user.roles.includes('list-models');

  element('login').hidden = true;
  element('session').hidden = false;
  element('identity').textContent = `${user.username} (${user.roles.join(', ') || 'no roles'})`;
  element('admin').hidden = !isAdmin;
  element('models').hidden = !canListModels;

  if (canListModels) {
    await refreshModels();
  }
  if (isAdmin) {
    await refreshAccounts(user);
  }
}

/** End the browser session, optionally revoking the account's other tokens too. */
function bindLogout(id, endpoint) {
  element(id).onclick = async () => {
    try {
      await api(endpoint, 'POST', {});
      location.reload();
    } catch (error) {
      element('status').textContent = error.message;
    }
  };
}

/** Connect the page forms and load an existing browser session if present. */
function initialize() {
  renderRoleInputs(element('newRoles'));

  bindForm(element('loginForm'), async data => {
    await api('login', 'POST', data);
    element('loginForm').reset();
    await refresh();
  });

  bindForm(element('createForm'), async data => {
    await api('users', 'POST', {
      ...data,
      roles: selectedRoles(element('newRoles')),
    });
    element('createForm').reset();
    await refresh();
    element('status').textContent = 'Account created.';
  });

  bindForm(element('passwordForm'), async data => {
    await api('password', 'POST', data);
    location.reload();
  });

  bindLogout('logout', 'logout');
  bindLogout('logoutAll', 'logout-all');

  refresh().catch(error => {
    element('status').textContent = error.message;
    element('login').hidden = false;
    element('session').hidden = true;
  });
}

initialize();
