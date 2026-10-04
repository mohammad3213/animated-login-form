const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const root = __dirname;
const productsPath = path.join(root, 'products.json');
const accountsPath = path.join(root, 'accounts.json');
const ordersPath = path.join(root, 'orders.json');

try {
  const envFile = fs.readFileSync(path.join(root, '.env'), 'utf8');
  for (const line of envFile.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || Object.hasOwn(process.env, match[1])) continue;
    process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const port = Number(process.env.PORT || 4242);
const host = process.env.HOST || '127.0.0.1';
const appUrl = (process.env.APP_URL || `http://localhost:${port}`).replace(/\/+$/, '');
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const adminPassword = process.env.ADMIN_PASSWORD || '';
const sessionCookie = 'pixelplay_admin';
const customerCookie = 'pixelplay_customer';
const sessionLifetime = 12 * 60 * 60 * 1000;
const adminSessionLifetime = 8 * 60 * 60 * 1000;
const publicFiles = new Set([
  'index.html', 'shop.html', 'admin.html', 'style.css', 'shop.css',
  'admin.css', 'script.js', 'shop.js', 'admin.js'
]);
const sessions = new Map();
const customerSessions = new Map();
const loginAttempts = new Map();
let products = JSON.parse(fs.readFileSync(productsPath, 'utf8'));
let accounts = readJsonFile(accountsPath, []);
let orders = readJsonFile(ordersPath, []);

const mimeTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

function sendJson(response, statusCode, body, headers = {}) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers
  });
  response.end(JSON.stringify(body));
}

function readJsonFile(filePath, fallback) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!Array.isArray(value)) throw new Error(`Expected an array in ${path.basename(filePath)}.`);
    return value;
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

function persistJsonFile(filePath, value) {
  const temporaryPath = `${filePath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { flag: 'w', mode: 0o600 });
  fs.renameSync(temporaryPath, filePath);
}

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derivedKey) => {
      if (error) return reject(error);
      resolve({ salt, hash: derivedKey.toString('hex') });
    });
  });
}

function passwordMatches(password, account) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, account.passwordSalt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (error, derivedKey) => {
      if (error) return reject(error);
      const savedHash = Buffer.from(account.passwordHash, 'hex');
      resolve(savedHash.length === derivedKey.length && crypto.timingSafeEqual(savedHash, derivedKey));
    });
  });
}

function createSession(response, accountId) {
  const token = crypto.randomBytes(32).toString('hex');
  customerSessions.set(token, { accountId, expiresAt: Date.now() + sessionLifetime });
  const secure = new URL(appUrl).protocol === 'https:' ? '; Secure' : '';
  response.setHeader(
    'Set-Cookie',
    `${customerCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionLifetime / 1000}${secure}`
  );
}

function getCustomerSession(request) {
  const token = getCookie(request, customerCookie);
  const session = customerSessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) customerSessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + sessionLifetime;
  return session;
}

function customerAccount(request, response) {
  const session = getCustomerSession(request);
  if (!session) {
    sendJson(response, 401, { error: 'Sign in to view your account or order history.' });
    return null;
  }
  const account = accounts.find((entry) => entry.id === session.accountId);
  if (!account) {
    sendJson(response, 401, { error: 'Your account session has expired. Please sign in again.' });
    return null;
  }
  return account;
}

function publicAccount(account) {
  const accountOrders = orders
    .filter((order) => order.accountId === account.id)
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  const totalSpentCents = accountOrders.reduce((total, order) => total + order.amountTotal, 0);
  return {
    profile: { id: account.id, name: account.name, email: account.email },
    totalSpentCents,
    orderCount: accountOrders.length,
    orders: accountOrders.map((order) => ({
      id: order.id,
      createdAt: order.createdAt,
      amountTotal: order.amountTotal,
      currency: order.currency,
      paymentMethod: order.paymentMethod
    }))
  };
}

function authRateLimited(request) {
  const address = request.socket.remoteAddress || 'unknown';
  const key = `customer:${address}`;
  let attempts = loginAttempts.get(key);
  if (attempts && Date.now() - attempts.windowStartedAt >= 15 * 60 * 1000) {
    loginAttempts.delete(key);
    attempts = null;
  }
  if (attempts && attempts.blockedUntil > Date.now()) return true;
  return false;
}

function recordAuthFailure(request) {
  const address = request.socket.remoteAddress || 'unknown';
  const key = `customer:${address}`;
  const current = loginAttempts.get(key) || { count: 0, blockedUntil: 0, windowStartedAt: Date.now() };
  current.count += 1;
  if (current.count >= 8) current.blockedUntil = current.windowStartedAt + 15 * 60 * 1000;
  loginAttempts.set(key, current);
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = '';
    let tooLarge = false;
    request.on('data', (chunk) => {
      if (tooLarge) return;
      body += chunk;
      if (body.length > 20_000) {
        tooLarge = true;
        reject(Object.assign(new Error('Request is too large.'), { statusCode: 413 }));
        request.resume();
      }
    });
    request.on('end', () => {
      if (tooLarge) return;
      try {
        const parsedBody = JSON.parse(body);
        if (!parsedBody || typeof parsedBody !== 'object' || Array.isArray(parsedBody)) {
          reject(Object.assign(new Error('Request must contain a JSON object.'), { statusCode: 400 }));
          return;
        }
        resolve(parsedBody);
      } catch {
        reject(Object.assign(new Error('Request must contain valid JSON.'), { statusCode: 400 }));
      }
    });
    request.on('error', reject);
  });
}

function centsAfterDiscount(product) {
  return Math.round(product.priceCents * (100 - product.discountPercent) / 100);
}

function publicProduct(product) {
  const discountedCents = centsAfterDiscount(product);
  return {
    id: product.id,
    name: product.name,
    category: product.category,
    type: product.type,
    delivery: product.delivery,
    description: product.description,
    image: product.image,
    alt: product.alt,
    price: discountedCents / 100,
    originalPrice: product.discountPercent ? product.priceCents / 100 : null,
    discountPercent: product.discountPercent,
    badge: product.badge,
    rating: product.rating,
    reviews: product.reviews,
    physical: product.physical
  };
}

function getProductInput(input, id) {
  const name = typeof input.name === 'string' ? input.name.trim() : '';
  const description = typeof input.description === 'string' ? input.description.trim() : '';
  const type = typeof input.type === 'string' ? input.type.trim() : '';
  const alt = typeof input.alt === 'string' ? input.alt.trim() : '';
  const image = typeof input.image === 'string' ? input.image.trim() : '';
  const delivery = input.category === 'gear' ? 'Physical item' : 'Digital game';
  const category = input.category;
  const price = Number(input.price);
  const discountPercent = Number(input.discountPercent || 0);
  const badge = typeof input.badge === 'string' ? input.badge.trim() : '';

  if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id) || id.length > 50) {
    throw Object.assign(new Error('Use a product ID with lowercase letters, numbers, and hyphens.'), { statusCode: 400 });
  }
  if (!name || name.length > 100 || !description || description.length > 300 ||
      !type || type.length > 50 || !alt || alt.length > 180) {
    throw Object.assign(new Error('Add a name, type, short description, and image description within the limits.'), { statusCode: 400 });
  }
  let imageUrl;
  try {
    imageUrl = new URL(image);
  } catch {
    throw Object.assign(new Error('Enter a valid HTTPS photo URL from images.unsplash.com or images.pexels.com.'), { statusCode: 400 });
  }
  if (imageUrl.protocol !== 'https:' ||
      !['images.unsplash.com', 'images.pexels.com'].includes(imageUrl.hostname)) {
    throw Object.assign(new Error('Product photos must use HTTPS from images.unsplash.com or images.pexels.com.'), { statusCode: 400 });
  }
  if (!['game', 'gear'].includes(category) || !Number.isFinite(price) ||
      price < 0.5 || price > 10000 || !Number.isInteger(discountPercent) ||
      discountPercent < 0 || discountPercent > 90 || badge.length > 24) {
    throw Object.assign(new Error('Check the category, price ($0.50–$10,000), discount (0–90%), and badge (24 characters max).'), { statusCode: 400 });
  }

  return {
    id, name, category, type, delivery, description,
    image: imageUrl.toString(), alt, priceCents: Math.round(price * 100),
    discountPercent, badge, rating: '', reviews: '0',
    physical: category === 'gear'
  };
}

function persistProducts() {
  const temporaryPath = `${productsPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(products, null, 2)}\n`, { flag: 'w' });
  fs.renameSync(temporaryPath, productsPath);
}

function getCookie(request, cookieName) {
  const cookies = request.headers.cookie || '';
  for (const part of cookies.split(';')) {
    const [name, ...value] = part.trim().split('=');
    if (name === cookieName) return value.join('=');
  }
  return '';
}

function getSession(request) {
  const token = getCookie(request, sessionCookie);
  const session = sessions.get(token);
  if (!session || session.expiresAt <= Date.now()) {
    if (token) sessions.delete(token);
    return null;
  }
  session.expiresAt = Date.now() + adminSessionLifetime;
  return session;
}

function requireAdmin(request, response) {
  if (!getSession(request)) {
    sendJson(response, 401, { error: 'Sign in to manage the shop.' });
    return false;
  }
  return true;
}

function requireSameOrigin(request, response) {
  const origin = request.headers.origin;
  let requestOrigin;
  try {
    requestOrigin = new URL(origin);
  } catch {
    sendJson(response, 403, { error: 'Request origin was not allowed.' });
    return false;
  }

  const configuredOrigin = new URL(appUrl);
  const loopbackHosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  const matchesRequestHost = request.headers.host === requestOrigin.host;
  const matchesConfiguredOrigin = requestOrigin.origin === configuredOrigin.origin;
  const isLocalhostAlias = requestOrigin.protocol === configuredOrigin.protocol &&
    requestOrigin.port === configuredOrigin.port &&
    loopbackHosts.has(requestOrigin.hostname) &&
    loopbackHosts.has(configuredOrigin.hostname);

  if (!matchesRequestHost || (!matchesConfiguredOrigin && !isLocalhostAlias)) {
    sendJson(response, 403, { error: 'Request origin was not allowed.' });
    return false;
  }
  return true;
}

function handleLogin(request, response) {
  if (!requireSameOrigin(request, response)) return;
  if (adminPassword.length < 12) {
    return sendJson(response, 503, { error: 'Set ADMIN_PASSWORD to a private password with at least 12 characters in .env.' });
  }

  const address = request.socket.remoteAddress || 'unknown';
  let attempts = loginAttempts.get(address);
  if (attempts && Date.now() - attempts.windowStartedAt >= 15 * 60 * 1000) {
    loginAttempts.delete(address);
    attempts = null;
  }
  if (attempts && attempts.blockedUntil > Date.now()) {
    return sendJson(response, 429, { error: 'Too many login attempts. Try again in 15 minutes.' });
  }

  void readJson(request).then((body) => {
    const submittedPassword = typeof body.password === 'string' ? body.password : '';
    const expectedHash = crypto.createHash('sha256').update(adminPassword).digest();
    const submittedHash = crypto.createHash('sha256').update(submittedPassword).digest();
    if (!crypto.timingSafeEqual(expectedHash, submittedHash)) {
      const current = loginAttempts.get(address) || {
        count: 0,
        blockedUntil: 0,
        windowStartedAt: Date.now()
      };
      current.count += 1;
      if (current.count >= 5) current.blockedUntil = current.windowStartedAt + 15 * 60 * 1000;
      loginAttempts.set(address, current);
      return sendJson(response, 401, { error: 'That password did not match.' });
    }

    loginAttempts.delete(address);
    const token = crypto.randomBytes(32).toString('hex');
    sessions.set(token, { expiresAt: Date.now() + adminSessionLifetime });
    const secure = new URL(appUrl).protocol === 'https:' ? '; Secure' : '';
    sendJson(response, 200, { authenticated: true }, {
      'Set-Cookie': `${sessionCookie}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${adminSessionLifetime / 1000}${secure}`
    });
  }).catch((error) => sendJson(response, error.statusCode || 400, {
    error: error.statusCode ? error.message : 'Could not process admin sign-in.'
  }));
}

function handleAdminApi(request, response, url) {
  const parts = url.pathname.split('/').filter(Boolean);
  const productId = parts.length === 4 ? parts[3] : '';

  if (parts[2] === 'session' && request.method === 'GET') {
    return sendJson(response, 200, { authenticated: Boolean(getSession(request)) });
  }
  if (parts[2] === 'login' && request.method === 'POST') {
    return handleLogin(request, response);
  }
  if (parts[2] === 'logout' && request.method === 'POST') {
    if (!requireSameOrigin(request, response)) return;
    const token = getCookie(request, sessionCookie);
    if (token) sessions.delete(token);
    const secure = new URL(appUrl).protocol === 'https:' ? '; Secure' : '';
    return sendJson(response, 200, { authenticated: false }, {
      'Set-Cookie': `${sessionCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
    });
  }

  if (!requireAdmin(request, response)) return;
  if (parts[2] === 'products' && request.method === 'GET' && parts.length === 3) {
    return sendJson(response, 200, { products: products.map(publicProduct) });
  }
  if (parts[2] === 'products' && ['POST', 'PUT', 'DELETE'].includes(request.method)) {
    if (!requireSameOrigin(request, response)) return;
    if (request.method === 'DELETE') {
      const index = products.findIndex((product) => product.id === productId);
      if (index === -1) return sendJson(response, 404, { error: 'Product not found.' });
      products.splice(index, 1);
      try {
        persistProducts();
        return sendJson(response, 200, { products: products.map(publicProduct) });
      } catch (error) {
        console.error('Could not save product catalogue:', error.message);
        return sendJson(response, 500, { error: 'Could not save the catalogue. Check the server data-folder permissions.' });
      }
    }

    void readJson(request).then((body) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return sendJson(response, 400, { error: 'Product details must be provided.' });
      }
      const id = request.method === 'POST' ? body.id : productId;
      const index = products.findIndex((product) => product.id === id);
      if (request.method === 'POST' && index !== -1) {
        return sendJson(response, 409, { error: 'That product ID is already in use.' });
      }
      if (request.method === 'PUT' && index === -1) {
        return sendJson(response, 404, { error: 'Product not found.' });
      }
      if (request.method === 'POST' && products.length >= 100) {
        return sendJson(response, 400, { error: 'The catalogue is full (100 products maximum).' });
      }

      const savedProduct = getProductInput(body, id);
      const originalProduct = index === -1 ? null : products[index];
      if (index === -1) products.push(savedProduct);
      else products[index] = { ...products[index], ...savedProduct };
      try {
        persistProducts();
        return sendJson(response, request.method === 'POST' ? 201 : 200, {
          products: products.map(publicProduct)
        });
      } catch (error) {
        if (index === -1) products.pop();
        else products[index] = originalProduct;
        console.error('Could not save product catalogue:', error.message);
        return sendJson(response, 500, { error: 'Could not save the catalogue. Check the server data-folder permissions.' });
      }
    }).catch((error) => sendJson(response, error.statusCode || 400, {
      error: error.statusCode ? error.message : 'Could not process the product.'
    }));
    return;
  }

  sendJson(response, 404, { error: 'Admin endpoint not found.' });
}

function checkoutLineItems(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 20) {
    throw Object.assign(new Error('Your cart is empty or contains too many different items.'), { statusCode: 400 });
  }
  const quantities = new Map();
  for (const item of items) {
    const productId = item && item.id;
    const product = products.find((entry) => entry.id === productId);
    const quantity = Number(item && item.quantity);
    if (!product || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
      throw Object.assign(new Error('A cart item is invalid. Please refresh your cart and try again.'), { statusCode: 400 });
    }
    const total = (quantities.get(productId) || 0) + quantity;
    if (total > 10) throw Object.assign(new Error('Your cart exceeds the purchase limit for an item.'), { statusCode: 400 });
    quantities.set(productId, total);
  }

  const itemsForStripe = [...quantities.entries()].map(([id, quantity]) => ({
    product: products.find((entry) => entry.id === id),
    quantity
  }));
  const hasPhysicalItems = itemsForStripe.some(({ product }) => product.physical);
  const physicalSubtotal = itemsForStripe.reduce((sum, { product, quantity }) =>
    product.physical ? sum + centsAfterDiscount(product) * quantity : sum, 0);
  const fields = itemsForStripe.reduce((result, { product, quantity }, index) => {
    result[`line_items[${index}][price_data][currency]`] = 'usd';
    result[`line_items[${index}][price_data][unit_amount]`] = String(centsAfterDiscount(product));
    result[`line_items[${index}][price_data][product_data][name]`] = product.name;
    result[`line_items[${index}][quantity]`] = String(quantity);
    return result;
  }, {});

  return { fields, hasPhysicalItems, freeStandardShipping: physicalSubtotal >= 7500 };
}

async function stripeRequest(endpoint, options = {}) {
  const stripeResponse = await fetch(`https://api.stripe.com/v1/${endpoint}`, {
    method: options.method || 'GET',
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`,
      ...(options.body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
    },
    body: options.body
  });
  const result = await stripeResponse.json();
  if (!stripeResponse.ok) {
    const error = new Error(result.error && result.error.message || 'Stripe could not complete the request.');
    error.statusCode = stripeResponse.status >= 500 ? 502 : 400;
    throw error;
  }
  return result;
}

function handleCustomerApi(request, response, url) {
  const route = url.pathname.slice('/api/account/'.length);
  if (route === 'session' && request.method === 'GET') {
    const session = getCustomerSession(request);
    const account = session && accounts.find((entry) => entry.id === session.accountId);
    return sendJson(response, 200, account
      ? { authenticated: true, ...publicAccount(account) }
      : { authenticated: false });
  }
  if (route === 'register' && request.method === 'POST') {
    if (!requireSameOrigin(request, response)) return;
    if (authRateLimited(request)) return sendJson(response, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    void readJson(request).then(async (body) => {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      if (name.length < 2 || name.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          email.length > 254 || password.length < 12 || password.length > 128) {
        recordAuthFailure(request);
        return sendJson(response, 400, { error: 'Enter a name, valid email, and password of at least 12 characters.' });
      }
      if (accounts.some((account) => account.email === email)) {
        recordAuthFailure(request);
        return sendJson(response, 409, { error: 'An account with this email already exists. Sign in instead.' });
      }
      const passwordData = await hashPassword(password);
      if (accounts.some((account) => account.email === email)) {
        recordAuthFailure(request);
        return sendJson(response, 409, { error: 'An account with this email already exists. Sign in instead.' });
      }
      const account = {
        id: crypto.randomUUID(),
        name,
        email,
        passwordSalt: passwordData.salt,
        passwordHash: passwordData.hash,
        createdAt: new Date().toISOString()
      };
      accounts.push(account);
      try {
        persistJsonFile(accountsPath, accounts);
      } catch (error) {
        accounts.pop();
        console.error('Could not save customer account:', error.message);
        return sendJson(response, 500, { error: 'Could not create your account. Please try again.' });
      }
      loginAttempts.delete(`customer:${request.socket.remoteAddress || 'unknown'}`);
      createSession(response, account.id);
      return sendJson(response, 201, { authenticated: true, ...publicAccount(account) });
    }).catch((error) => {
      if (error.statusCode) return sendJson(response, error.statusCode, { error: error.message });
      console.error('Customer registration failed:', error.message);
      sendJson(response, 500, { error: 'Could not create your account. Please try again.' });
    });
    return;
  }
  if (route === 'login' && request.method === 'POST') {
    if (!requireSameOrigin(request, response)) return;
    if (authRateLimited(request)) return sendJson(response, 429, { error: 'Too many attempts. Try again in 15 minutes.' });
    void readJson(request).then(async (body) => {
      const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
      const password = typeof body.password === 'string' ? body.password : '';
      const account = accounts.find((entry) => entry.email === email);
      if (!account || password.length > 128 || !(await passwordMatches(password, account))) {
        recordAuthFailure(request);
        return sendJson(response, 401, { error: 'Email or password did not match.' });
      }
      loginAttempts.delete(`customer:${request.socket.remoteAddress || 'unknown'}`);
      createSession(response, account.id);
      return sendJson(response, 200, { authenticated: true, ...publicAccount(account) });
    }).catch((error) => {
      if (error.statusCode) return sendJson(response, error.statusCode, { error: error.message });
      console.error('Customer sign-in failed:', error.message);
      sendJson(response, 500, { error: 'Could not sign in. Please try again.' });
    });
    return;
  }
  if (route === 'logout' && request.method === 'POST') {
    if (!requireSameOrigin(request, response)) return;
    const token = getCookie(request, customerCookie);
    if (token) customerSessions.delete(token);
    const secure = new URL(appUrl).protocol === 'https:' ? '; Secure' : '';
    return sendJson(response, 200, { authenticated: false }, {
      'Set-Cookie': `${customerCookie}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure}`
    });
  }
  if (route === 'profile' && request.method === 'PUT') {
    if (!requireSameOrigin(request, response)) return;
    const account = customerAccount(request, response);
    if (!account) return;
    void readJson(request).then((body) => {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (name.length < 2 || name.length > 80) {
        return sendJson(response, 400, { error: 'Your name must be between 2 and 80 characters.' });
      }
      const previousName = account.name;
      account.name = name;
      try {
        persistJsonFile(accountsPath, accounts);
        return sendJson(response, 200, publicAccount(account));
      } catch (error) {
        account.name = previousName;
        console.error('Could not save customer profile:', error.message);
        return sendJson(response, 500, { error: 'Could not save your profile. Please try again.' });
      }
    }).catch((error) => sendJson(response, error.statusCode || 400, {
      error: error.statusCode ? error.message : 'Could not save your profile.'
    }));
    return;
  }
  return sendJson(response, 404, { error: 'Account route not found.' });
}

async function handleCheckout(request, response) {
  const account = customerAccount(request, response);
  if (!account) return;
  if (!requireSameOrigin(request, response)) return;
  if (!stripeSecretKey || !/^sk_(test|live)_/.test(stripeSecretKey)) {
    return sendJson(response, 503, { error: 'Online checkout is not configured. Add a Stripe secret key to your local .env file.' });
  }
  if (stripeSecretKey.startsWith('sk_live_') && process.env.ALLOW_LIVE_PAYMENTS !== 'true') {
    return sendJson(response, 503, { error: 'Live payments are disabled. Review the go-live checklist before enabling them.' });
  }

  try {
    const body = await readJson(request);
    const checkout = checkoutLineItems(body.items);
    const fields = new URLSearchParams({
      mode: 'payment',
      'payment_method_types[0]': 'card',
      client_reference_id: account.id,
      customer_email: account.email,
      'metadata[account_id]': account.id,
      billing_address_collection: 'required',
      allow_promotion_codes: 'true',
      success_url: `${appUrl}/shop.html?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${appUrl}/shop.html?checkout=cancelled`
    });
    if (checkout.hasPhysicalItems) {
      for (const [index, country] of ['US', 'CA', 'GB', 'AU'].entries()) {
        fields.set(`shipping_address_collection[allowed_countries][${index}]`, country);
      }
      fields.set('phone_number_collection[enabled]', 'true');
      const shippingOptions = [
        { name: 'Standard shipping', amount: checkout.freeStandardShipping ? 0 : 599, min: 4, max: 8 },
        { name: 'Express shipping', amount: 1499, min: 1, max: 2 }
      ];
      shippingOptions.forEach((option, index) => {
        const prefix = `shipping_options[${index}][shipping_rate_data]`;
        fields.set(`${prefix}[type]`, 'fixed_amount');
        fields.set(`${prefix}[display_name]`, option.name);
        fields.set(`${prefix}[fixed_amount][currency]`, 'usd');
        fields.set(`${prefix}[fixed_amount][amount]`, String(option.amount));
        fields.set(`${prefix}[delivery_estimate][minimum][unit]`, 'business_day');
        fields.set(`${prefix}[delivery_estimate][minimum][value]`, String(option.min));
        fields.set(`${prefix}[delivery_estimate][maximum][unit]`, 'business_day');
        fields.set(`${prefix}[delivery_estimate][maximum][value]`, String(option.max));
      });
    }
    for (const [key, value] of Object.entries(checkout.fields)) fields.set(key, value);
    const session = await stripeRequest('checkout/sessions', { method: 'POST', body: fields.toString() });
    sendJson(response, 200, { url: session.url });
  } catch (error) {
    if (error.statusCode >= 500) console.error('Stripe checkout request failed:', error.message);
    sendJson(response, error.statusCode || 500, {
      error: error.statusCode ? error.message : 'Could not start checkout. Please try again.'
    });
  }
}

async function handleCheckoutStatus(request, sessionId, response) {
  const account = customerAccount(request, response);
  if (!account) return;
  if (!/^cs_(test|live)_[A-Za-z0-9]+$/.test(sessionId)) {
    return sendJson(response, 400, { error: 'Invalid checkout session.' });
  }
  if (!stripeSecretKey || !/^sk_(test|live)_/.test(stripeSecretKey)) {
    return sendJson(response, 503, { error: 'Payment status is not available until Stripe is configured.' });
  }
  if (stripeSecretKey.startsWith('sk_live_') && process.env.ALLOW_LIVE_PAYMENTS !== 'true') {
    return sendJson(response, 503, { error: 'Live payment verification is disabled for this sample catalogue.' });
  }
  try {
    const session = await stripeRequest(`checkout/sessions/${encodeURIComponent(sessionId)}?expand%5B%5D=payment_intent.payment_method`);
    if (session.client_reference_id !== account.id) {
      return sendJson(response, 404, { error: 'This checkout does not belong to your account.' });
    }
    if (session.payment_status === 'paid' && !orders.some((order) => order.id === session.id)) {
      const paymentMethod = session.payment_intent &&
        typeof session.payment_intent === 'object' &&
        session.payment_intent.payment_method &&
        typeof session.payment_intent.payment_method === 'object'
        ? session.payment_intent.payment_method
        : null;
      const order = {
        id: session.id,
        accountId: account.id,
        createdAt: new Date((session.created || Math.floor(Date.now() / 1000)) * 1000).toISOString(),
        amountTotal: session.amount_total,
        currency: session.currency,
        paymentMethod: paymentMethod && paymentMethod.card
          ? { label: `${paymentMethod.card.brand.toUpperCase()} ending in ${paymentMethod.card.last4}` }
          : { label: 'Card payment' }
      };
      if (!Number.isInteger(order.amountTotal) || order.amountTotal < 0 || typeof order.currency !== 'string') {
        return sendJson(response, 502, { error: 'Stripe returned incomplete payment details. Contact support before retrying.' });
      }
      orders.push(order);
      try {
        persistJsonFile(ordersPath, orders);
      } catch (error) {
        orders.pop();
        console.error('Could not save verified order:', error.message);
        return sendJson(response, 500, { error: 'Payment is complete, but your order history could not be updated. Contact support.' });
      }
    }
    sendJson(response, 200, { paymentStatus: session.payment_status, status: session.status });
  } catch (error) {
    if (error.statusCode >= 500) console.error('Stripe status request failed:', error.message);
    sendJson(response, error.statusCode || 500, {
      error: error.statusCode ? error.message : 'Could not verify this payment.'
    });
  }
}

function serveFile(request, response, pathname) {
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(pathname);
  } catch {
    response.writeHead(400);
    response.end('Bad request');
    return;
  }
  const requestedPath = decodedPath === '/' ? '/index.html' : decodedPath;
  const filePath = path.resolve(root, `.${requestedPath}`);
  if (!filePath.startsWith(`${root}${path.sep}`) ||
      !publicFiles.has(path.relative(root, filePath))) {
    response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(error.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(error.code === 'ENOENT' ? 'Not found' : 'Could not read file');
      return;
    }
    response.writeHead(200, {
      'Content-Type': mimeTypes[path.extname(filePath)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'strict-origin-when-cross-origin',
      'X-Frame-Options': 'DENY'
    });
    if (request.method === 'HEAD') response.end();
    else response.end(content);
  });
}

const server = http.createServer((request, response) => {
  const url = new URL(request.url, appUrl);
  if (url.pathname === '/api/products' && request.method === 'GET') {
    return sendJson(response, 200, { products: products.map(publicProduct) });
  }
  if (url.pathname.startsWith('/api/account/')) {
    if (!['GET', 'POST', 'PUT'].includes(request.method)) {
      response.writeHead(405, { Allow: 'GET, POST, PUT' });
      response.end('Method not allowed');
      return;
    }
    return handleCustomerApi(request, response, url);
  }
  if (url.pathname.startsWith('/api/admin/')) return handleAdminApi(request, response, url);
  if (url.pathname === '/api/checkout' && request.method === 'POST') {
    void handleCheckout(request, response);
    return;
  }
  const sessionMatch = url.pathname.match(/^\/api\/checkout-sessions\/([^/]+)$/);
  if (sessionMatch && request.method === 'GET') {
    void handleCheckoutStatus(request, sessionMatch[1], response);
    return;
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    response.writeHead(405, { Allow: 'GET, HEAD, POST, PUT, DELETE' });
    response.end('Method not allowed');
    return;
  }
  serveFile(request, response, url.pathname);
});

server.listen(port, host, () => {
  console.log(`PixelPlay is running at ${appUrl}`);
  if (!stripeSecretKey) console.warn('Stripe is not configured. Add STRIPE_SECRET_KEY to .env before accepting payments.');
  if (adminPassword.length < 12) console.warn('Admin is disabled until a private ADMIN_PASSWORD of at least 12 characters is set in .env.');
});
