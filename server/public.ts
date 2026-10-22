import { Hono } from 'hono'
import {
  PHONE_RE,
  base64ToBytes,
  fail,
  getSettings,
  newId,
  normalizePhone,
  nowIso,
  publicOrder,
  publicProduct,
  readJson,
  type AppEnv,
  type OrderItem,
  type OrderRow,
  type ProductRow,
} from './lib'

const app = new Hono<AppEnv>()

/* ------------------------------- store info -------------------------------- */

app.get('/api/store', async (c) => {
  const settings = await getSettings(c.env.DB, ['store_name', 'store_phone', 'announcement', 'shipping_fee'])
  return c.json({
    ok: true,
    store: {
      name: settings.store_name || 'متجرنا',
      phone: settings.store_phone || '',
      announcement: settings.announcement || '',
      shippingFee: Number(settings.shipping_fee || 0),
    },
  })
})

/* -------------------------------- products --------------------------------- */

app.get('/api/categories', async (c) => {
  const rows = await c.env.DB.prepare(
    "SELECT category, COUNT(*) AS count FROM products WHERE active = 1 AND category <> '' GROUP BY category ORDER BY count DESC",
  ).all<{ category: string; count: number }>()
  return c.json({
    ok: true,
    categories: (rows.results ?? []).map((r) => ({ name: r.category, count: r.count })),
  })
})

app.get('/api/products', async (c) => {
  const category = (c.req.query('category') || '').trim()
  const q = (c.req.query('q') || '').trim()

  const where: string[] = ['active = 1']
  const binds: (string | number)[] = []
  if (category) {
    where.push('category = ?')
    binds.push(category)
  }
  if (q) {
    where.push('(name LIKE ? OR description LIKE ?)')
    binds.push(`%${q}%`, `%${q}%`)
  }

  const rows = await c.env.DB.prepare(
    `SELECT * FROM products WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT 200`,
  )
    .bind(...binds)
    .all<ProductRow>()

  return c.json({ ok: true, products: (rows.results ?? []).map(publicProduct) })
})

app.get('/api/products/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT * FROM products WHERE id = ? AND active = 1').bind(c.req.param('id')).first<ProductRow>()
  if (!row) return fail(c, 404, 'المنتج غير موجود')
  return c.json({ ok: true, product: publicProduct(row) })
})

/* --------------------------------- images ---------------------------------- */

app.get('/api/images/:key', async (c) => {
  const key = c.req.param('key')
  if (!/^[A-Za-z0-9._-]{1,120}$/.test(key)) return fail(c, 400, 'مسار صورة غير صحيح')
  const row = await c.env.DB.prepare('SELECT content_type, data FROM images WHERE key = ?')
    .bind(key)
    .first<{ content_type: string; data: string }>()
  if (!row) return fail(c, 404, 'الصورة غير موجودة')
  return new Response(base64ToBytes(row.data), {
    headers: {
      'Content-Type': row.content_type,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'X-Content-Type-Options': 'nosniff',
    },
  })
})

/* --------------------------------- orders ---------------------------------- */

type CreateOrderBody = {
  name?: string
  phone?: string
  address?: string
  notes?: string
  paymentRef?: string
  items?: { productId?: string; qty?: number }[]
}

app.post('/api/orders', async (c) => {
  const body = await readJson<CreateOrderBody>(c)
  if (!body) return fail(c, 400, 'بيانات الطلب غير صحيحة')

  const name = (body.name || '').trim()
  const phone = normalizePhone(body.phone || '')
  const address = (body.address || '').trim()
  const notes = (body.notes || '').trim().slice(0, 500)
  const paymentRef = (body.paymentRef || '').trim().slice(0, 40)
  const rawItems = Array.isArray(body.items) ? body.items : []

  if (name.length < 3) return fail(c, 400, 'اكتب الاسم بالكامل')
  if (!PHONE_RE.test(phone)) return fail(c, 400, 'رقم الموبايل غير صحيح (مثال: 01012345678)')
  if (address.length < 10) return fail(c, 400, 'اكتب العنوان بالتفصيل (المدينة والشارع)')
  if (rawItems.length === 0) return fail(c, 400, 'السلة فاضية')

  const ids = [...new Set(rawItems.map((i) => String(i.productId || '')))].filter((id) => id.length > 0)
  if (ids.length === 0) return fail(c, 400, 'السلة فاضية')

  const placeholders = ids.map(() => '?').join(', ')
  const productRows = await c.env.DB.prepare(`SELECT * FROM products WHERE id IN (${placeholders}) AND active = 1`)
    .bind(...ids)
    .all<ProductRow>()
  const products = new Map((productRows.results ?? []).map((p) => [p.id, p]))

  const items: OrderItem[] = []
  const quantities = new Map<string, number>()

  for (const raw of rawItems) {
    const product = products.get(String(raw.productId || ''))
    if (!product) return fail(c, 400, ' أحد المنتجات لم يعد متاحًا، حدّث السلة')
    const qty = Math.floor(Number(raw.qty))
    if (!Number.isFinite(qty) || qty < 1 || qty > 20) return fail(c, 400, 'الكمية غير صحيحة')
    const next = (quantities.get(product.id) || 0) + qty
    if (next > product.stock) return fail(c, 400, `الكمية المطلوبة من «${product.name}» غير متوفرة`)
    quantities.set(product.id, next)
    items.push({
      productId: product.id,
      name: product.name,
      price: product.price,
      qty,
      image: product.image_key ? `/api/images/${product.image_key}` : null,
    })
  }

  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0)
  const settings = await getSettings(c.env.DB, ['shipping_fee'])
  const shipping = Number(settings.shipping_fee || 0)
  const total = subtotal + shipping

  const paymentNumbers = [
    ...new Set(
      items
        .map((item) => products.get(item.productId)?.vodafone_number || '')
        .filter((n) => n.trim().length > 0),
    ),
  ].join(', ')

  let code = ''
  for (let attempt = 0; attempt < 6; attempt++) {
    code = String(Math.floor(100000 + Math.random() * 900000))
    const clash = await c.env.DB.prepare('SELECT 1 FROM orders WHERE code = ?').bind(code).first()
    if (!clash) break
    code = ''
  }
  if (!code) return fail(c, 500, 'تعذّر إنشاء رقم الطلب، حاول مرة أخرى')

  const id = newId()
  const createdAt = nowIso()
  const stockUpdates = [...quantities.entries()].map(([productId, qty]) =>
    c.env.DB.prepare('UPDATE products SET stock = stock - ? WHERE id = ? AND stock >= ?').bind(qty, productId, qty),
  )

  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO orders (id, code, customer_name, phone, address, notes, items, subtotal, shipping, total,
        payment_number, payment_ref, payment_status, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'new', ?, ?)`,
    ).bind(
      id,
      code,
      name,
      phone,
      address,
      notes,
      JSON.stringify(items),
      subtotal,
      shipping,
      total,
      paymentNumbers,
      paymentRef,
      createdAt,
      createdAt,
    ),
    ...stockUpdates,
  ])

  const row: OrderRow = {
    id,
    code,
    customer_name: name,
    phone,
    address,
    notes,
    items: JSON.stringify(items),
    subtotal,
    shipping,
    total,
    payment_number: paymentNumbers,
    payment_ref: paymentRef,
    payment_status: 'pending',
    status: 'new',
    created_at: createdAt,
    updated_at: createdAt,
  }

  return c.json({ ok: true, order: publicOrder(row) }, 201)
})

app.get('/api/payment/numbers', async (c) => {
  const ids = (c.req.query('ids') || '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .slice(0, 50)

  if (ids.length === 0) return c.json({ ok: true, numbers: [] })

  const placeholders = ids.map(() => '?').join(', ')
  const rows = await c.env.DB.prepare(
    `SELECT DISTINCT vodafone_number FROM products WHERE id IN (${placeholders}) AND active = 1 AND vodafone_number <> ''`,
  )
    .bind(...ids)
    .all<{ vodafone_number: string }>()

  const numbers = [...new Set((rows.results ?? []).map((row) => row.vodafone_number).filter(Boolean))]
  return c.json({ ok: true, numbers })
})

app.get('/api/orders/track', async (c) => {
  const phone = normalizePhone(c.req.query('phone') || '')
  if (!PHONE_RE.test(phone)) return fail(c, 400, 'رقم الموبايل غير صحيح')

  const rows = await c.env.DB.prepare('SELECT * FROM orders WHERE phone = ? ORDER BY created_at DESC LIMIT 30')
    .bind(phone)
    .all<OrderRow>()

  return c.json({ ok: true, orders: (rows.results ?? []).map(publicOrder) })
})

app.get('/api/orders/:code', async (c) => {
  const code = (c.req.param('code') || '').replace(/[^0-9]/g, '')
  const phone = normalizePhone(c.req.query('phone') || '')
  if (code.length !== 6 || !PHONE_RE.test(phone)) return fail(c, 400, 'بيانات التتبّع غير صحيحة')

  const row = await c.env.DB.prepare('SELECT * FROM orders WHERE code = ? AND phone = ?').bind(code, phone).first<OrderRow>()
  if (!row) return fail(c, 404, 'لا يوجد طلب بهذا الرقم')
  return c.json({ ok: true, order: publicOrder(row) })
})

/* -------------------------------- bootstrap -------------------------------- */

export default app
