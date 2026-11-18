import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

const hostOf = (url: string | undefined): string | null => {
  try {
    return url?.trim() ? new URL(url.trim()).host.toLowerCase() : null;
  } catch {
    return null;
  }
};

/**
 * On the card setup address (CARD_SETUP_BASE_URL, when it is its own host),
 * only card setup pages and the Stripe webhook are served; every other page
 * goes to the same path on the main address (NEXT_PUBLIC_APP_URL).
 */
function cardHostRedirect(request: NextRequest): NextResponse | null {
  const cardHost = hostOf(process.env.CARD_SETUP_BASE_URL);
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.trim();
  const appHost = hostOf(appUrl);
  if (!cardHost || !appUrl || !appHost || cardHost === appHost) return null;
  if ((request.headers.get('host') ?? request.nextUrl.host).toLowerCase() !== cardHost) return null;
  const { pathname, search } = request.nextUrl;
  if (pathname.startsWith('/card-setup/') || pathname.startsWith('/api/stripe/webhook/')) return null;
  return NextResponse.redirect(new URL(pathname + search, appUrl), 308);
}

export async function updateSession(request: NextRequest) {
  const toMain = cardHostRedirect(request);
  if (toMain) return toMain;

  let supabaseResponse = NextResponse.next({
    request,
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll();
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          );
          supabaseResponse = NextResponse.next({
            request,
          });
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          );
        },
      },
    }
  );

  const {
    data: { user },
  } = await supabase.auth.getUser();

  const isAuthPage =
    request.nextUrl.pathname.startsWith('/login') ||
    request.nextUrl.pathname.startsWith('/register');
  const isPublicFriendsFamilyPage =
    request.nextUrl.pathname === '/fnforders' ||
    request.nextUrl.pathname === '/friends-family-order-form';
  // Stripe saved cards: customers open setup links without an account, and
  // Stripe calls the webhook without a session (it verifies its signature).
  const isPublicStripePath =
    request.nextUrl.pathname.startsWith('/card-setup/') ||
    request.nextUrl.pathname.startsWith('/api/stripe/webhook/');

  if (!user && !isAuthPage && !isPublicFriendsFamilyPage && !isPublicStripePath) {
    const url = request.nextUrl.clone();
    url.pathname = '/login';
    return NextResponse.redirect(url);
  }

  if (user && isAuthPage) {
    const url = request.nextUrl.clone();
    url.pathname = '/';
    return NextResponse.redirect(url);
  }

  return supabaseResponse;
}
