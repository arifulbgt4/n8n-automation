# Customer Meta OAuth return route

The Meta app redirects to the API callback configured as `META_OAUTH_REDIRECT_URI`. After token exchange and Page discovery, the API sends the browser to the Customer Panel root:

```text
/?view=businesses&tenantId=<tenant-id>&businessId=<business-id>&metaConnection=<short-lived-discovery-id>
```

The root Customer Panel opens the selected business and its embedded Channels section. The customer selects a Facebook Page or linked Instagram professional account there. Completion verifies/subscribes the Page's Meta webhooks before persisting the channel. A provider cancellation/error follows the same route with `metaError` in place of `metaConnection`.

`/channels` remains only as a compatibility return route for OAuth attempts started before this change or old bookmarks. It resolves the discovery to a tenant and business, then redirects to the unified Business & Channels screen. It is no longer a separate management page or sidebar item.

Discovery state expires after 15 minutes. If it is missing or does not belong to the authenticated customer, the panel shows an error and the user can restart the connection from their business. The API callback URI itself must exactly match the URI configured in Meta's Facebook Login for Business settings.
