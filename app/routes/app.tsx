import type {
  HeadersFunction,
  LoaderFunctionArgs,
  ActionFunctionArgs,
} from "react-router";
import AppNav from "../components/AppNav";
import {
  Outlet,
  useLoaderData,
  useRouteError,
  redirect,
} from "react-router";

import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { authenticate } from "../shopify.server";
import prisma from "../db.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const authResult = await authenticate.admin(request);

    if (authResult instanceof Response) {
      return authResult;
    }

    const { session } = authResult ?? {};

    if (!session || !session.shop) {
      console.error("No session or shop found");
      return redirect("/?error=no-session");
    }

    const formData = await request.formData();

    const taxRateInput = formData.get("taxRate");
    const carrierChargeInput = formData.get("carrierCharge");
    const usdToEuroRateInput = formData.get("usdToEuroRate");

    if (
      !taxRateInput ||
      !carrierChargeInput ||
      !usdToEuroRateInput
    ) {
      return redirect("/app?error=missing-fields");
    }

    const taxRate = parseFloat(taxRateInput as string);
    const carrierCharge = parseFloat(carrierChargeInput as string);
    const usdToEuroRate = parseFloat(usdToEuroRateInput as string);

    if (
      isNaN(taxRate) ||
      isNaN(carrierCharge) ||
      isNaN(usdToEuroRate)
    ) {
      return redirect("/app?error=invalid-values");
    }

    await prisma.settings_be.upsert({
      where: {
        shop: session.shop,
      },
      update: {
        taxPercentage: taxRate,
        carrierCharge,
        usdToEuroRate,
        updatedAt: new Date(),
      },
      create: {
        id: `settings-${session.shop}`,
        shop: session.shop,
        taxPercentage: taxRate,
        carrierCharge,
        usdToEuroRate,
        updatedAt: new Date(),
      },
    });

    return redirect("/app?updated=true");
  } catch (error) {
    console.error("App action error:", error);

    if (error instanceof Response) {
      throw error;
    }

    return redirect("/app?error=server-error");
  }
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const authResult = await authenticate.admin(request);

  if (authResult instanceof Response) {
    return authResult;
  }

  const { session } = authResult ?? {};

  if (!session || !session.shop) {
    return redirect("/?error=no-session");
  }

  return {
    apiKey: process.env.SHOPIFY_API_KEY || "",
  };
};

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();

  return (
    <AppProvider embedded apiKey={apiKey}>
      <AppNav />
      <Outlet />
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};