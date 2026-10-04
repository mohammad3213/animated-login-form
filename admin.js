const loginPanel = document.getElementById('loginPanel');
const dashboard = document.getElementById('dashboard');
const loginForm = document.getElementById('loginForm');
const productForm = document.getElementById('productForm');
const loginMessage = document.getElementById('loginMessage');
const productMessage = document.getElementById('productMessage');
const productList = document.getElementById('adminProductList');
const productSearch = document.getElementById('productSearch');
const clearProductSearch = document.getElementById('clearProductSearch');
const catalogueEmpty = document.getElementById('catalogueEmpty');
const toast = document.getElementById('adminToast');
let products = [];
let toastTimer;

async function api(url, options = {}) {
  const response = await fetch(url, {
    credentials: 'same-origin',
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'The admin request failed.');
  return result;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function setAuthenticated(authenticated) {
  loginPanel.hidden = authenticated;
  dashboard.hidden = !authenticated;
}

function showToast(message) {
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2500);
}

function renderProducts() {
  document.getElementById('productCount').textContent = products.length;
  document.getElementById('saleCount').textContent = products.filter((product) => product.discountPercent > 0).length;
  const query = productSearch.value.trim().toLocaleLowerCase();
  const matches = products.filter((product) =>
    [product.name, product.id, product.category, product.type, product.description]
      .some((value) => String(value).toLocaleLowerCase().includes(query))
  );
  productList.innerHTML = matches.map((product) => `
    <article class="admin-product">
      <img src="${escapeHtml(product.image)}" alt="" loading="lazy" />
      <div class="admin-product-info">
        <strong>${escapeHtml(product.name)}</strong>
        <small>${escapeHtml(product.category === 'gear' ? 'Gaming gear' : 'Digital game')} · $${Number(product.originalPrice || product.price).toFixed(2)}</small>
        <small class="${product.discountPercent ? 'sale-label' : ''}">${product.discountPercent ? `${product.discountPercent}% off · now $${Number(product.price).toFixed(2)}` : 'No active discount'}</small>
      </div>
      <div class="product-actions">
        <button type="button" data-edit="${escapeHtml(product.id)}">Edit</button>
        <button class="delete-button" type="button" data-delete="${escapeHtml(product.id)}">Delete</button>
      </div>
    </article>`).join('');
  catalogueEmpty.hidden = products.length === 0 || matches.length > 0;
  clearProductSearch.hidden = query.length === 0;
}

async function refreshProducts() {
  const result = await api('/api/admin/products');
  products = result.products;
  renderProducts();
}

function resetEditor() {
  productForm.reset();
  productForm.elements.editingId.value = '';
  productForm.elements.discountPercent.value = '0';
  productForm.elements.id.disabled = false;
  document.getElementById('editorKicker').textContent = 'NEW LISTING';
  document.getElementById('editorTitle').textContent = 'Add a product';
  document.getElementById('saveProduct').innerHTML = 'Add product <span>→</span>';
  productMessage.textContent = '';
}

function editProduct(product) {
  productForm.elements.editingId.value = product.id;
  productForm.elements.name.value = product.name;
  productForm.elements.id.value = product.id;
  productForm.elements.id.disabled = true;
  productForm.elements.category.value = product.category;
  productForm.elements.type.value = product.type;
  productForm.elements.price.value = Number(product.originalPrice || product.price).toFixed(2);
  productForm.elements.discountPercent.value = product.discountPercent;
  productForm.elements.description.value = product.description;
  productForm.elements.image.value = product.image;
  productForm.elements.alt.value = product.alt;
  productForm.elements.badge.value = product.badge || '';
  document.getElementById('editorKicker').textContent = 'EDIT LISTING';
  document.getElementById('editorTitle').textContent = product.name;
  document.getElementById('saveProduct').innerHTML = 'Save product <span>→</span>';
  productMessage.textContent = '';
  productForm.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginMessage.textContent = '';
  const button = loginForm.querySelector('button[type="submit"]');
  button.disabled = true;
  try {
    await api('/api/admin/login', {
      method: 'POST',
      body: JSON.stringify({ password: loginForm.elements.password.value })
    });
    loginForm.reset();
    setAuthenticated(true);
    await refreshProducts();
  } catch (error) {
    loginMessage.textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

productForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  productMessage.textContent = '';
  const formData = new FormData(productForm);
  const editingId = formData.get('editingId');
  const product = Object.fromEntries(formData.entries());
  delete product.editingId;
  const saveButton = document.getElementById('saveProduct');
  saveButton.disabled = true;
  try {
    const result = await api(editingId
      ? `/api/admin/products/${encodeURIComponent(editingId)}`
      : '/api/admin/products', {
      method: editingId ? 'PUT' : 'POST',
      body: JSON.stringify(product)
    });
    products = result.products;
    renderProducts();
    resetEditor();
    showToast(editingId ? 'Product and discount updated.' : 'Product added to the store.');
  } catch (error) {
    productMessage.textContent = error.message;
  } finally {
    saveButton.disabled = false;
  }
});

productList.addEventListener('click', async (event) => {
  const editButton = event.target.closest('[data-edit]');
  const deleteButton = event.target.closest('[data-delete]');
  if (editButton) {
    const product = products.find((entry) => entry.id === editButton.dataset.edit);
    if (product) editProduct(product);
  } else if (deleteButton) {
    const product = products.find((entry) => entry.id === deleteButton.dataset.delete);
    if (!product || !window.confirm(`Delete "${product.name}" from the store?`)) return;
    try {
      const result = await api(`/api/admin/products/${encodeURIComponent(product.id)}`, { method: 'DELETE' });
      products = result.products;
      renderProducts();
      showToast('Product removed from the store.');
    } catch (error) {
      showToast(error.message);
    }
  }
});

document.getElementById('resetForm').addEventListener('click', resetEditor);
productSearch.addEventListener('input', renderProducts);
clearProductSearch.addEventListener('click', () => {
  productSearch.value = '';
  renderProducts();
  productSearch.focus();
});
document.getElementById('logoutButton').addEventListener('click', async () => {
  try {
    await api('/api/admin/logout', { method: 'POST', body: '{}' });
    setAuthenticated(false);
    products = [];
    productList.replaceChildren();
    productSearch.value = '';
    catalogueEmpty.hidden = true;
    resetEditor();
    showToast('You are signed out.');
  } catch (error) {
    showToast(error.message);
  }
});

api('/api/admin/session')
  .then(async ({ authenticated }) => {
    setAuthenticated(authenticated);
    if (authenticated) await refreshProducts();
  })
  .catch((error) => {
    loginMessage.textContent = error.message;
  });
