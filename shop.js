const productGrid = document.getElementById('productGrid');
const discountGrid = document.getElementById('discountGrid');
const searchInput = document.getElementById('productSearch');
const emptyState = document.getElementById('emptyState');
const cartDrawer = document.getElementById('cartDrawer');
const cartCount = document.getElementById('cartCount');
const cartItems = document.getElementById('cartItems');
const cartEmpty = document.getElementById('cartEmpty');
const cartSubtotal = document.getElementById('cartSubtotal');
const drawerItemCount = document.getElementById('drawerItemCount');
const checkoutButton = document.getElementById('checkoutButton');
const shopToast = document.getElementById('shopToast');
const accountLink = document.getElementById('accountLink');
const typeFilterGroup = document.getElementById('typeFilterGroup');
const typeFilter = document.getElementById('typeFilter');
const typeFilterLabel = document.getElementById('typeFilterLabel');
let selectedCategory = 'all';
let selectedType = 'all';
let products = [];
let toastTimer;
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });

function loadCart() {
  const savedCart = localStorage.getItem('pixelplay-cart');
  if (!savedCart) return [];
  try {
    const parsedCart = JSON.parse(savedCart);
    if (!Array.isArray(parsedCart)) throw new SyntaxError('Saved cart was not a list.');
    return parsedCart.filter((item) =>
      item && typeof item.id === 'string' &&
      Number.isInteger(item.quantity) && item.quantity > 0 && item.quantity <= 10
    );
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    console.warn('Invalid saved cart data was discarded.');
    localStorage.removeItem('pixelplay-cart');
    return [];
  }
}

let cart = loadCart();

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  })[character]);
}

function renderProduct(product) {
  const rating = Number(product.rating);
  const ratingMarkup = Number.isFinite(rating) && rating > 0
    ? `<div class="product-rating"><span aria-label="${rating.toFixed(1)} out of 5 stars">★★★★★</span> ${rating.toFixed(1)} <span class="review-count">(${escapeHtml(product.reviews)} reviews)</span></div>`
    : '<div class="product-rating new-product">New arrival · No reviews yet</div>';
  const badge = product.discountPercent > 0
    ? `<span class="product-tag sale-tag">${product.discountPercent}% OFF</span>`
    : product.badge ? `<span class="product-tag">${escapeHtml(product.badge)}</span>` : '';

  return `
    <article class="product-card">
      <div class="product-art">
        ${badge}
        <img src="${escapeHtml(product.image)}" alt="${escapeHtml(product.alt)}" loading="lazy" />
      </div>
      <div class="product-info">
        <span class="product-category">${escapeHtml(product.type)}</span>
        <h3>${escapeHtml(product.name)}</h3>
        <p class="product-description">${escapeHtml(product.description)}</p>
        ${ratingMarkup}
        <div class="product-bottom">
          <span class="product-price">${currency.format(product.price)}${product.originalPrice ? `<span class="product-old-price">${currency.format(product.originalPrice)}</span>` : ''}<small class="product-delivery">${escapeHtml(product.delivery)}</small></span>
          <button class="add-button" type="button" data-add="${escapeHtml(product.id)}" aria-label="Add ${escapeHtml(product.name)} to cart">+</button>
        </div>
      </div>
    </article>`;
}

function renderProducts() {
  const query = searchInput.value.trim().toLowerCase();
  const visibleProducts = products.filter((product) => {
    const matchesCategory = selectedCategory === 'all' || product.category === selectedCategory;
    const matchesType = selectedType === 'all' || product.type === selectedType;
    const searchable = `${product.name} ${product.type} ${product.description}`.toLowerCase();
    return matchesCategory && matchesType && searchable.includes(query);
  });

  productGrid.innerHTML = visibleProducts.map(renderProduct).join('');
  emptyState.hidden = visibleProducts.length > 0;
  const sales = products.filter((product) => product.discountPercent > 0).slice(0, 4);
  discountGrid.innerHTML = sales.map(renderProduct).join('');
  document.getElementById('discounts').hidden = sales.length === 0;
  document.getElementById('dealsNav').hidden = sales.length === 0;
}

function renderTypeFilters() {
  const relevantProducts = selectedCategory === 'all'
    ? []
    : products.filter((product) => product.category === selectedCategory);
  const types = [...new Set(relevantProducts.map((product) => product.type).filter(Boolean))]
    .sort((left, right) => left.localeCompare(right));

  typeFilterGroup.hidden = types.length === 0;
  if (types.length === 0) {
    typeFilter.replaceChildren();
    selectedType = 'all';
    return;
  }

  typeFilterLabel.textContent = selectedCategory === 'game' ? 'SHOP BY GENRE' : 'SHOP BY GEAR TYPE';
  typeFilter.innerHTML = [
    '<button class="category-chip selected" type="button" data-type="all">All</button>',
    ...types.map((type) =>
      `<button class="category-chip" type="button" data-type="${escapeHtml(type)}">${escapeHtml(type)}</button>`
    )
  ].join('');
}

function showToast(message) {
  shopToast.textContent = message;
  shopToast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => shopToast.classList.remove('show'), 2600);
}

function setCartOpen(open) {
  document.body.classList.toggle('cart-open', open);
  cartDrawer.setAttribute('aria-hidden', String(!open));
}

function updateCart() {
  cart = cart.filter((item) => products.some((product) => product.id === item.id));
  const itemCount = cart.reduce((sum, item) => sum + item.quantity, 0);
  const subtotal = cart.reduce((sum, item) => {
    const product = products.find((entry) => entry.id === item.id);
    return sum + product.price * item.quantity;
  }, 0);

  localStorage.setItem('pixelplay-cart', JSON.stringify(cart));
  cartCount.textContent = itemCount;
  drawerItemCount.textContent = `(${itemCount})`;
  cartSubtotal.textContent = currency.format(subtotal);
  cartEmpty.hidden = cart.length > 0;
  cartItems.hidden = cart.length === 0;
  checkoutButton.disabled = cart.length === 0;
  cartItems.innerHTML = cart.map((item) => {
    const product = products.find((entry) => entry.id === item.id);
    return `
      <div class="cart-row">
        <img class="cart-thumb" src="${escapeHtml(product.image)}" alt="" />
        <div>
          <h3 class="cart-product-name">${escapeHtml(product.name)}</h3>
          <p class="cart-product-price">${currency.format(product.price)} each</p>
          <div class="quantity-control">
            <button type="button" data-quantity="${escapeHtml(item.id)}" data-change="-1" aria-label="Remove one ${escapeHtml(product.name)}">−</button>
            <span>${item.quantity}</span>
            <button type="button" data-quantity="${escapeHtml(item.id)}" data-change="1" aria-label="Add one ${escapeHtml(product.name)}">+</button>
          </div>
        </div>
        <button class="remove-item" type="button" data-remove="${escapeHtml(item.id)}" aria-label="Remove ${escapeHtml(product.name)} from cart">Remove</button>
      </div>`;
  }).join('');
  checkoutButton.textContent = 'Continue to secure checkout →';
}

document.querySelectorAll('.category-chip').forEach((button) => {
  button.addEventListener('click', () => {
    selectedCategory = button.dataset.category;
    selectedType = 'all';
    document.querySelectorAll('.category-chip').forEach((chip) => {
      if (chip.dataset.category) chip.classList.toggle('selected', chip === button);
    });
    renderTypeFilters();
    renderProducts();
  });
});

typeFilter.addEventListener('click', (event) => {
  const button = event.target.closest('[data-type]');
  if (!button) return;
  selectedType = button.dataset.type;
  typeFilter.querySelectorAll('[data-type]').forEach((chip) => {
    chip.classList.toggle('selected', chip === button);
  });
  renderProducts();
});

searchInput.addEventListener('input', renderProducts);

document.addEventListener('click', (event) => {
  const addButton = event.target.closest('[data-add]');
  if (addButton) {
    const item = cart.find((entry) => entry.id === addButton.dataset.add);
    if (item && item.quantity >= 10) return showToast('You can add up to 10 of each item.');
    if (item) item.quantity += 1;
    else cart.push({ id: addButton.dataset.add, quantity: 1 });
    updateCart();
    showToast('Added to your cart!');
    return;
  }

  const quantityButton = event.target.closest('[data-quantity]');
  const removeButton = event.target.closest('[data-remove]');
  if (quantityButton) {
    const item = cart.find((entry) => entry.id === quantityButton.dataset.quantity);
    if (!item) return;
    if (quantityButton.dataset.change === '1' && item.quantity >= 10) {
      return showToast('You can add up to 10 of each item.');
    }
    item.quantity += Number(quantityButton.dataset.change);
    if (item.quantity <= 0) cart = cart.filter((entry) => entry !== item);
    updateCart();
  } else if (removeButton) {
    cart = cart.filter((item) => item.id !== removeButton.dataset.remove);
    updateCart();
  }
});

document.getElementById('cartToggle').addEventListener('click', () => setCartOpen(true));
document.getElementById('closeCart').addEventListener('click', () => setCartOpen(false));
document.getElementById('drawerBackdrop').addEventListener('click', () => setCartOpen(false));
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') setCartOpen(false);
});

async function startCheckout() {
  if (!cart.length) return;
  if (window.location.protocol === 'file:') {
    showToast('Secure checkout needs the shop server. Follow the setup guide in README.md.');
    return;
  }
  checkoutButton.disabled = true;
  checkoutButton.textContent = 'Connecting securely…';
  try {
    const response = await fetch('/api/checkout', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    body: JSON.stringify({ items: cart.map(({ id, quantity }) => ({ id, quantity })) })
    });
    const result = await response.json();
    if (response.status === 401) {
      window.location.assign('index.html?next=checkout');
      return;
    }
    if (!response.ok) throw new Error(result.error || 'Could not start checkout.');
    if (typeof result.url !== 'string' || !result.url.startsWith('https://checkout.stripe.com/')) {
      throw new Error('The checkout service returned an invalid payment link.');
    }
    window.location.assign(result.url);
  } catch (error) {
    showToast(error.message);
    checkoutButton.disabled = false;
    checkoutButton.textContent = 'Continue to secure checkout →';
  }
}

checkoutButton.addEventListener('click', () => void startCheckout());

async function loadAccountLink() {
  try {
    const response = await fetch('/api/account/session', { credentials: 'same-origin' });
    const result = await response.json();
    if (response.ok && result.authenticated) {
      accountLink.textContent = `Hi, ${result.profile.name.split(' ')[0]}`;
      accountLink.href = 'index.html';
      accountLink.setAttribute('aria-label', 'View your PixelPlay account');
    }
  } catch (error) {
    console.warn('Could not load account status:', error.message);
  }
}

async function loadProducts() {
  try {
    const response = await fetch('/api/products');
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Could not load the shop catalogue.');
    products = result.products;
    renderTypeFilters();
    renderProducts();
    updateCart();
  } catch (error) {
    showToast(error.message || 'Could not load the shop. Please refresh to try again.');
    productGrid.innerHTML = '<p class="empty-state">Start the shop server with <code>npm start</code> and open <code>http://localhost:4242</code>.</p>';
    discountGrid.replaceChildren();
    document.getElementById('discounts').hidden = true;
  }
}

const checkoutParams = new URLSearchParams(window.location.search);
if (checkoutParams.get('checkout') === 'cancelled') {
  showToast('Checkout cancelled. Your cart is still here.');
  window.history.replaceState({}, '', window.location.pathname + window.location.hash);
} else if (checkoutParams.get('checkout') === 'success') {
  const sessionId = checkoutParams.get('session_id');
  if (!sessionId) {
    showToast('Payment confirmation is missing. Please contact support before ordering again.');
  } else {
    fetch(`/api/checkout-sessions/${encodeURIComponent(sessionId)}`, { credentials: 'same-origin' })
      .then(async (response) => {
        const result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Could not verify your payment.');
        if (result.paymentStatus !== 'paid') throw new Error('Payment is not confirmed yet. Please check your email.');
        cart = [];
        updateCart();
        showToast('Payment confirmed. Thank you — your order is paid.');
        window.history.replaceState({}, '', window.location.pathname + window.location.hash);
      })
      .catch((error) => showToast(error.message));
  }
} else if (checkoutParams.get('checkout') === 'resume') {
  window.history.replaceState({}, '', window.location.pathname + window.location.hash);
}

void loadAccountLink();
void loadProducts().then(() => {
  if (checkoutParams.get('checkout') === 'resume') {
    setCartOpen(true);
    if (cart.length) void startCheckout();
  }
});
