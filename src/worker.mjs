export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/api/info') {
      return Response.json({ app: 'razer-device-control', name: 'Peripheral Workbench', discovery: 'Windows PnP and Razer HID', transport: 'authenticated Windows loopback companion' });
    }
    const response = await env.ASSETS.fetch(request);
    const headers = new Headers(response.headers);
    headers.set('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self' http://127.0.0.1:17321; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    headers.set('X-Content-Type-Options', 'nosniff');
    headers.set('Referrer-Policy', 'no-referrer');
    headers.set('Permissions-Policy', 'loopback-network=(self)');
    return new Response(response.body, { status: response.status, headers });
  }
};
