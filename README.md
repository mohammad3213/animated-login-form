# PixelPlay

A storefront with private shopper accounts, Stripe-hosted checkout, and a private product manager. The catalogue starts with example listings. Product reviews are not fabricated; card details are entered at Stripe and never handled by this app.

## Run locally

1. Install Node.js 18 or newer.
2. Copy `.env.example` to `.env`.
3. Set `STRIPE_SECRET_KEY` in `.env` to a Stripe **test-mode** secret key. Keep the key private. Never put it in browser code or commit `.env`.
4. Set `ADMIN_PASSWORD` to a private password with at least 12 characters. Do not use a password you use elsewhere.
5. Keep `APP_URL=http://localhost:4242` for local testing.
6. Run `npm start`, then open <http://localhost:4242/>. The private manager is at <http://localhost:4242/admin.html>.
7. Create a shopper account with a valid email and a password of at least 12 characters. A shopper account is required to check out.
8. To test a card payment, use Stripe's test card `4242 4242 4242 4242`, any future expiry date, and any three-digit CVC. Test cards only work with a Stripe test-mode key.

The manager can add, edit, and remove products, change prices, update product images, and set per-product percentage discounts. Game genres and gear types are taken from each product's Type field and automatically become storefront filters when shoppers select Games or Gaming gear. Starter products have no discounts; the deals section appears only when you configure a sale. Catalogue changes persist in `products.json`. Admin sessions use an HttpOnly, SameSite cookie, same-origin checks, and login throttling. By default, the server binds to `127.0.0.1` so the admin is available only on the local machine.

The server checks product prices and active discounts against its own catalogue; it does not trust prices sent by the browser. Stripe Checkout collects billing and payment details, and accepts Stripe promotion codes. For physical gear it collects a shipping address in the US, Canada, UK, or Australia, and offers standard shipping (4–8 business days, $5.99 or free for $75+ of physical items) and express shipping (1–2 business days, $14.99). The shop verifies completed payments with Stripe before saving an order and clearing the cart. The account page totals only these verified paid orders, and shows Stripe's card brand and last four digits when available. PixelPlay never stores full card numbers or security codes and does not save cards for later.

Shopper accounts are stored in the private, Git-ignored `accounts.json` file with scrypt password hashes; verified order summaries are stored separately in the Git-ignored `orders.json` file. Session cookies are HttpOnly, SameSite, and expire after 12 hours. Keep both files private, back them up securely, and use a production database and Stripe webhooks before launching publicly. Email addresses are not verified by this sample app.

Product photos use Unsplash; game listings are fictional starter examples and their photos illustrate a genre or gaming setup rather than official game cover art. Replace the sample catalogue with authorized product photography before taking real orders. The admin accepts HTTPS image URLs from `images.unsplash.com` or `images.pexels.com`. Inventory management, shipping fulfillment, automatic tax, and order emails are not implemented.

## Before going live

- Replace sample products, prices, photos, and shipping rates with accurate, authorized business data.
- Add webhook-backed order records and implement inventory, shipping fulfillment, digital delivery, taxes, refunds, and customer emails.
- Store production Stripe credentials as private environment variables on your hosting provider. Live payments are blocked unless `ALLOW_LIVE_PAYMENTS=true`.
- Configure `APP_URL` as your public HTTPS origin. If your host requires it, set `HOST=0.0.0.0` behind HTTPS, firewall, and appropriate access controls. Do not expose the local development server directly to the internet.
- Review shipping destinations, prices, return policy, and privacy information before accepting real orders.
