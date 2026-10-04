const toggleButtons = document.querySelectorAll('.toggle-btn, .text-btn');
const forms = {
  login: document.getElementById('loginForm'),
  register: document.getElementById('registerForm')
};
const authCard = document.querySelector('.auth-card');
const accountPanel = document.getElementById('accountPanel');
const toast = document.getElementById('toast');
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const checkoutRedirect = new URLSearchParams(window.location.search).get('next') === 'checkout';

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timeoutId);
  showToast.timeoutId = setTimeout(() => toast.classList.remove('show'), 3200);
}

function setMode(mode) {
  const nextMode = mode === 'register' ? 'register' : 'login';
  Object.entries(forms).forEach(([key, form]) => form.classList.toggle('active', key === nextMode));
  document.querySelectorAll('.toggle-btn').forEach((button) => {
    button.classList.toggle('active', button.dataset.mode === nextMode);
  });
}

function renderAccount(data) {
  document.getElementById('profileName').value = data.profile.name;
  document.getElementById('profileEmail').value = data.profile.email;
  document.getElementById('totalSpent').textContent = currency.format(data.totalSpentCents / 100);
  document.getElementById('orderCount').textContent = data.orderCount;
  const orderList = document.getElementById('orderList');
  orderList.innerHTML = data.orders.length
    ? data.orders.map((order) => {
      const date = new Date(order.createdAt);
      const amount = currency.format(order.amountTotal / 100);
      return `<article class="order-card">
        <div><strong>${escapeHtml(amount)}</strong><time datetime="${escapeHtml(order.createdAt)}">${escapeHtml(date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))}</time></div>
        <span>${escapeHtml(order.paymentMethod.label)}</span>
        <small>Order ${escapeHtml(order.id.slice(-8).toUpperCase())}</small>
      </article>`;
    }).join('')
    : '<p class="orders-empty">No completed orders yet. Your verified purchases will appear here.</p>';
  authCard.hidden = true;
  accountPanel.hidden = false;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...options.headers }
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'The request could not be completed.');
  return data;
}

async function submitAuth(form, mode) {
  const submitButton = form.querySelector('[type="submit"]');
  submitButton.disabled = true;
  try {
    const values = new FormData(form);
    const body = {
      email: String(values.get('email') || '').trim(),
      password: String(values.get('password') || '')
    };
    if (mode === 'register') {
      body.name = String(values.get('fullName') || '').trim();
      if (body.password !== String(values.get('confirmPassword') || '')) {
        throw new Error('Passwords do not match.');
      }
    }
    const data = await apiRequest(`/api/account/${mode}`, {
      method: 'POST',
      body: JSON.stringify(body)
    });
    form.reset();
    if (checkoutRedirect) {
      window.location.href = 'shop.html?checkout=resume';
      return;
    }
    renderAccount(data);
    showToast(mode === 'register' ? 'Your PixelPlay account is ready.' : 'You are signed in.');
  } catch (error) {
    showToast(error.message);
  } finally {
    submitButton.disabled = false;
  }
}

toggleButtons.forEach((button) => button.addEventListener('click', () => setMode(button.dataset.mode)));
forms.login.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!forms.login.reportValidity()) return;
  void submitAuth(forms.login, 'login');
});
forms.register.addEventListener('submit', (event) => {
  event.preventDefault();
  if (!forms.register.reportValidity()) return;
  void submitAuth(forms.register, 'register');
});

document.getElementById('profileForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = event.currentTarget.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const data = await apiRequest('/api/account/profile', {
      method: 'PUT',
      body: JSON.stringify({ name: document.getElementById('profileName').value })
    });
    renderAccount(data);
    showToast('Your profile was updated.');
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

document.getElementById('logoutButton').addEventListener('click', async () => {
  try {
    await apiRequest('/api/account/logout', { method: 'POST', body: '{}' });
    accountPanel.hidden = true;
    authCard.hidden = false;
    setMode('login');
    showToast('You have signed out.');
  } catch (error) {
    showToast(error.message);
  }
});

void apiRequest('/api/account/session').then((data) => {
  if (!data.authenticated) return;
  if (checkoutRedirect) {
    window.location.href = 'shop.html?checkout=resume';
    return;
  }
  renderAccount(data);
}).catch((error) => showToast(error.message));
