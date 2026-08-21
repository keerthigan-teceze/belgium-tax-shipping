import type { LoaderFunctionArgs, ActionFunctionArgs } from "react-router";
import prisma from "../db.server";
import { logRequest } from "../lib/requestLog";

interface ShopifyRateItem {
  name: string;
  sku: string;
  quantity: number;
  grams: number;
  price: number;
  vendor: string;
  requires_shipping: boolean;
  taxable: boolean;
  product_id: number;
  variant_id: number;
}

interface ShopifyRateRequest {
  rate: {
    origin: {
      country: string;
      postal_code: string;
      province: string | null;
      city: string | null;
      name: string | null;
      address1: string;
      address2: string | null;
    };
    destination: {
      country: string;
      postal_code: string;
      province: string;
      city: string;
      name: string;
      address1: string;
      address2: string | null;
    };
    items: ShopifyRateItem[];
    currency: string;
    locale: string;
  };
}

interface ShopifyRateResponse {
  rates: Array<{
    service_name: string;
    service_code: string;
    total_price: string;
    currency: string;
    description: string;
  }>;
}


const TAX_ONLY_PRODUCT_TYPES = [
  "Security Software",
  "Manufacturing Equipment Repair Services",
  "Document Management Software",
  "Video Surveillance Software",
  "Software Licenses/Upgrades",
  "IT Infrastructure Software",
  "IT Courses",
  "Business Management Software",
  "Barcode & Labelling Software",
  "Warranty & Support",
  "Networking Software",
  "Warranty & Support Extensions",
  "IT Support Services",
  "Communication Software",
  "Multimedia Software",
  "PC Utilities Software",
  "Data Storage Services",
  "Installation Services",
  "Operating Systems",
  "Servers",
  "Cloud Solutions"
];

function isTaxOnly(productType?: string | null): boolean {
  return productType
    ? TAX_ONLY_PRODUCT_TYPES.some(
        (type) =>
          type.toLowerCase().trim() === productType.toLowerCase().trim()
      )
    : false;
}


// Fetch live USD to EUR exchange rate
async function getUsdToEurRate(): Promise<number> {
  try {
    const response = await fetch(
      "https://api.frankfurter.app/latest?from=USD&to=EUR"
    );

    if (response.ok) {
      const data = await response.json();
      return data.rates?.EUR || 0.86;
    }
  } catch (error) {
    console.error(error);
  }

  return 0.86;
}
async function getProduct(
  sku: string | null
): Promise<{ price: number | null; productType: string | null }> {

  if (!sku) {
    return {
      price: null,
      productType: null,
    };
  }

  let productType: string | null = null;
  let price: number | null = null;

  const mapping = await prisma.productMapping_be.findFirst({
    where: { sku },
    select: { price: true },
  });

  if (mapping?.price) {
    price = Number(mapping.price);
  }

  const sourceProduct = await prisma.shopify_products_final_be.findUnique({
    where: { sku },
    select: {
      price: true,
      product_type: true,
    },
  });

  if (sourceProduct) {
    productType = sourceProduct.product_type ?? null;

    if (price === null && sourceProduct.price) {
      price = Number(sourceProduct.price);
    }
  }

  return {
    price,
    productType,
  };
}
async function processRequest(shop: string, requestBody: ShopifyRateRequest): Promise<ShopifyRateResponse> {
  const items = requestBody.rate?.items || [];
  
  console.log("Processing request for shop:", shop);
  console.log(items)
  console.log("Items received:", items.map(i => ({ sku: i.sku, quantity: i.quantity })));
  
  const settings = await prisma.settings_be.findUnique({
    where: { shop },
  });

  console.log("Settings found:", settings);

  if (!settings) {
    await logRequest(shop, "incoming", "/app/api/shipping-rates", "POST", "", JSON.stringify({ error: "No settings" }), 500, "No settings for shop", 0);
    return {
      rates: [{
        service_name: "Belgium Standard Shipping",
        service_code: "BE_STD",
        total_price: "0",
        currency: "EUR",
        description: "Configuration required",
      }],
    };
  }

  // Get live exchange rate
  let exchangeRate = await getUsdToEurRate();
  console.log("Exchange rate (USD to EUR):", exchangeRate);
  exchangeRate = exchangeRate * 1.015; // Add 1.5% buffer to account for fluctuations and fees
  console.log("Adjusted exchange rate with buffer:", exchangeRate);

  let totalPriceEur = 0;
  let hasItems = false;
  let allItemsTaxOnly = true;

  for (const item of items) {
    if (!item.requires_shipping) continue;

    hasItems = true;
    const { price: dbPrice, productType } = await getProduct( item.sku);

    if (!isTaxOnly(productType)) {
      allItemsTaxOnly = false;
    }

    let priceEur: number;

    if (dbPrice !== null) {
      // DB price is already in EUR
      priceEur = dbPrice;
    } else {
      // Shopify price is in USD pennies - convert to EUR
      const priceUsd = Number(item.price) / 100;
      priceEur = priceUsd * exchangeRate;
      console.log(`Price for SKU ${item.sku} not found in DB, converted from USD ${priceUsd} to EUR ${priceEur}`);
    }

console.log(`SKU: ${item.sku}, Price (EUR): ${priceEur}, Qty: ${item.quantity}, productType: ${productType}`);
    totalPriceEur += priceEur * item.quantity;
  }

  console.log("Total price (EUR) calculated:", totalPriceEur);

  if (!hasItems) {
    return {
      rates: [{
        service_name: "Belgium Standard Shipping",
        service_code: "BE_STD",
        total_price: "0",
        currency: "EUR",
        description: "No shipping required for this order",
      }],
    };
  }

  // Calculate only shipping costs: tax on items + carrier charge
  // Note: basePrice is not included - Shopify adds that separately
  const taxAmount = totalPriceEur * (settings.taxPercentage / 100);
  const carrierCharge = allItemsTaxOnly ? 0 : settings.carrierCharge;
  const shippingCost = taxAmount + carrierCharge;

  console.log("Final calculation:", { totalPriceEur, taxAmount, carrierCharge, shippingCost, allItemsTaxOnly });

  const response = {
    rates: [{
      service_name: "Belgium Standard Shipping",
      service_code: "BE_STD",
      total_price: Math.round(shippingCost * 100).toString(),
      currency: "EUR",
      description: "Standard delivery within Belgium",
    }],
  };

  console.log("Final response:", JSON.stringify(response));

  return response;
}

export async function action({ request }: ActionFunctionArgs) {
  console.log("========== CALLBACK HIT ==========");
  const startTime = Date.now();
  const requestBodyStr = await request.text();
  
  let shop = request.headers.get("X-Shopify-Shop-Domain") || "";
  
  if (!shop) {
    const url = new URL(request.url);
    shop = url.searchParams.get("shop") || "";
  }
  
  if (!shop) {
    shop = "default";
  }
  
  console.log("Shop domain from request:", shop);
  
  let requestBody: ShopifyRateRequest | null = null;

  try {
    if (requestBodyStr) {
      requestBody = JSON.parse(requestBodyStr);
    }
  } catch {
    // Keep as null if parse fails
  }

  if (!requestBody?.rate) {
    const response = { 
      rates: [{
        service_name: "Belgium Standard Shipping",
        service_code: "BE_STD",
        total_price: "0",
        currency: "EUR",
        description: "Invalid request",
      }] 
    };
    await logRequest(
      shop,
      "incoming",
      "/app/api/shipping-rates",
      "POST",
      requestBodyStr ? requestBodyStr.substring(0, 500) : "",
      JSON.stringify(response),
      400,
      "Invalid request format - no rate object",
      Date.now() - startTime
    );
    return Response.json(response, { status: 400 });
  }

  try {
    const result = await processRequest(shop, requestBody);
    
    await logRequest(
      shop,
      "incoming",
      "/app/api/shipping-rates",
      "POST",
      JSON.stringify({ items: requestBody.rate.items.map(i => ({ sku: i.sku, quantity: i.quantity })) }),
      JSON.stringify(result),
      result.rates[0]?.total_price !== "0" ? 200 : 404,
      result.rates[0]?.total_price === "0" ? "No valid rates" : undefined,
      Date.now() - startTime
    );

    console.log("Response being sent:", JSON.stringify(result));

    return Response.json(result);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    const response = { 
      rates: [{
        service_name: "Belgium Standard Shipping",
        service_code: "BE_STD",
        total_price: "0",
        currency: "EUR",
        description: "Error: " + errorMessage,
      }] 
    };
    
    await logRequest(
      shop,
      "incoming",
      "/app/api/shipping-rates",
      "POST",
      requestBodyStr ? requestBodyStr.substring(0, 500) : "",
      JSON.stringify(response),
      500,
      errorMessage,
      Date.now() - startTime
    );

    return Response.json(response, { status: 500 });
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  const startTime = Date.now();
  const url = new URL(request.url);
  const shop = url.searchParams.get("shop") || "default";

  const response = { 
    rates: [{
      service_name: "Belgium Standard Shipping",
      service_code: "BE_STD",
      total_price: "0",
      currency: "EUR",
      description: "Use POST method for shipping rates",
    }] 
  };
  
  await logRequest(
    shop,
    "incoming",
    "/app/api/shipping-rates",
    "GET",
    "",
    JSON.stringify(response),
    200,
    undefined,
    Date.now() - startTime
  );

  return Response.json(response);
}
