# Customer Meta OAuth return route

The Meta API callback redirects a successful Facebook Login for Business authorization to the Customer Panel origin at:

```text
/channels?metaConnection=<short-lived-discovery-id>
```

`customer-panel/app/channels/page.tsx` is a dedicated OAuth return route. It renders `MetaChannelCallback`, which:

1. validates that the user still has an authenticated Customer Panel session;
2. resolves the short-lived discovery ID against the user's tenant memberships;
3. loads the Facebook Pages and linked Instagram professional accounts returned by Meta;
4. lets the customer choose the Facebook or Instagram account to connect;
5. calls the existing channel-completion API, which performs automatic `subscribed_apps` verification/subscription before persisting the channel; and
6. returns the browser to the main Customer Panel after the connection succeeds.

This route exists separately from the Customer Panel's in-app Channels navigation. The main application remains a single dashboard at `/`; `/channels` is specifically the OAuth landing route so external Meta redirects do not produce a Next.js 404.

If `metaError` is returned by Meta, the landing route displays the provider error and offers a return to the Customer Panel. If the discovery ID is missing, expired, or cannot be resolved to one of the authenticated user's memberships, the route shows a connection-expired/error state rather than creating a partial channel.
