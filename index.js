const mysql = require("mysql2/promise");
const AWS = require("aws-sdk");

const secretsManager = new AWS.SecretsManager();

let pool;
let cachedConfig;

async function getDbConfig() {
  if (cachedConfig) return cachedConfig;

  const secretArn = process.env.DB_SECRET_ARN;
  if (!secretArn) {
    console.error("DB_SECRET_ARN is not set");
    throw new Error("Missing DB_SECRET_ARN env var");
  }

  const res = await secretsManager
    .getSecretValue({ SecretId: secretArn })
    .promise();

  let secretString = res.SecretString;
  if (!secretString && res.SecretBinary) {
    secretString = Buffer.from(res.SecretBinary, "base64").toString("utf8");
  }

  const parsed = JSON.parse(secretString);

  const host = parsed.host;
  const user = parsed.username;
  const password = parsed.password;
  const database = parsed.dbname || parsed.database || "storedb";
  const port = parsed.port ? Number(parsed.port) : 3306;

  if (!host || !user || !password) {
    console.error("Invalid DB secret payload", parsed);
    throw new Error("DB secret missing required fields");
  }

  cachedConfig = { host, user, password, database, port };
  return cachedConfig;
}

async function getPool() {
  if (!pool) {
    const cfg = await getDbConfig();

    pool = await mysql.createPool({
      host: cfg.host,
      user: cfg.user,
      password: cfg.password,
      database: cfg.database,
      port: cfg.port,
      waitForConnections: true,
      connectionLimit: 5,
      queueLimit: 0
    });
  }
  return pool;
}

function response(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET,POST,OPTIONS"
    },
    body: JSON.stringify(body)
  };
}

exports.health = async () => {
  return response(200, { status: "ok" });
};

exports.getProducts = async () => {
  try {
    const pool = await getPool();
    const [rows] = await pool.query(
      "SELECT id, name, price, image_url FROM products"
    );
    return response(200, rows);
  } catch (err) {
    console.error("Error /products:", err);
    return response(500, { error: "DB_ERROR" });
  }
};

exports.createOrder = async (event) => {
  try {
    if (!event.body) {
      console.warn("createOrder: EMPTY_BODY");
      return response(400, { error: "EMPTY_BODY" });
    }

    let payload;
    try {
      payload = JSON.parse(event.body);
    } catch {
      console.warn("createOrder: INVALID_JSON", { body: event.body });
      return response(400, { error: "INVALID_JSON" });
    }

    const items = payload.items;
    if (!Array.isArray(items) || items.length === 0) {
      console.warn("createOrder: EMPTY_CART", { payload });
      return response(400, { error: "EMPTY_CART" });
    }

    const pool = await getPool();

    const ids = items.map(i => i.productId);
    const [products] = await pool.query(
      "SELECT id, price FROM products WHERE id IN (?)",
      [ids]
    );

    const priceMap = new Map(products.map(p => [p.id, Number(p.price)]));

    let total = 0;
    for (const item of items) {
      const qty = item.quantity ? Number(item.quantity) : 1;
      const price = priceMap.get(item.productId);
      if (price == null) {
        console.warn("createOrder: PRODUCT_NOT_FOUND", { productId: item.productId });
        return response(400, {
          error: "PRODUCT_NOT_FOUND",
          productId: item.productId
        });
      }
      total += price * qty;
    }

    const [result] = await pool.query(
      "INSERT INTO orders (total_amount, created_at) VALUES (?, NOW())",
      [total]
    );

    console.log("createOrder: ORDER_CREATED_OK", {
      orderId: result.insertId,
      itemsCount: items.length,
      total
    });

    return response(201, { status: "ok", total });
  } catch (err) {
    console.error("Error /order:", err);
    return response(500, { error: "DB_ERROR" });
  }
};
