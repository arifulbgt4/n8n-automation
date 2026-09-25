# Media upload limits and VPS storage protection

Customer media uploads are constrained by the tenant package. Limits are enforced by the API before a new file is written to Media Storage.

## Default package policy

| Limit | Free | Pro |
| --- | ---: | ---: |
| Max image resolution | 10 MP | 10 MP |
| Max stored images | 100 | 300 |
| Max encoded image size | 10 MB | 10 MB |
| Total media storage | 512 MB | 2 GB |

These values are operational defaults and can be changed by Super Admin without a payment integration.

Super Admin page:

```text
/media-plans
```

Admin API:

```text
PATCH /v1/admin/plans/:planId/media-allowance
```

Customer/API usage endpoint:

```text
GET /v1/tenants/:tenantId/media/limits
```

## Why more than a megapixel limit is required

A 10-megapixel image does not have a predictable encoded byte size. PNG, JPEG and WebP files with identical pixel dimensions may consume very different storage. Therefore four controls are applied together:

1. `maxImageMegapixels` limits decoded image dimensions.
2. `maxImageBytes` limits the encoded image payload.
3. `maxImageAssets` limits the number of managed images stored by a tenant.
4. `mediaStorageBytes` caps all active media bytes for the tenant.

The package belongs to the tenant/workspace, so the quota is shared by users inside that workspace rather than multiplied by team seats.

## Pre-storage duplicate detection

The API calculates SHA-256 before sending the file to Media Storage. If the same active file already exists in the same tenant/business scope, the existing media asset is returned and no second physical file is written. This prevents repeated product-image uploads from consuming additional VPS storage.

The existing Media Storage service still retains its own disk-reserve and per-media-user byte quota as an independent infrastructure safety layer.

## Supported image formats for megapixel verification

The API safely verifies dimensions for:

- JPEG
- PNG
- WebP
- GIF

An image format whose dimensions cannot be verified is rejected rather than bypassing the megapixel policy.

## Errors

Relevant API errors include:

- `IMAGE_MEGAPIXEL_LIMIT`
- `IMAGE_FILE_SIZE_LIMIT`
- `IMAGE_COUNT_LIMIT_REACHED`
- `MEDIA_STORAGE_LIMIT_REACHED`
- `IMAGE_FORMAT_UNSUPPORTED`

Deleting an unused media asset removes it from active image/storage quota calculations once the asset is marked deleted.
