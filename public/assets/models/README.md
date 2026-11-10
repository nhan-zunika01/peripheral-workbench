# Model images

Keep model images here, separate from interface icons and scripts. Match images by exact model aliases in `catalog.js`; product name and physical device ID are different things.

```
models/
  catalog.js
  razer-viper-v3-pro-se/
    top.webp
    side.webp
    thumbnail.webp
    source.json
```

Use the same structure for each mouse, keyboard, headset or other peripheral. Prefer transparent WebP/PNG, sRGB, object-fit contain; roughly 1000–1600px for a full view and 480px for thumbnails. Set image paths under `/assets/models/<model-id>/` and record the creator, original source URL, permission/license, date and any alterations in `source.json` and the catalog. Never ship expiring Figma URLs or hotlink remote images.

The current Figma draft contains no model photograph. Viper V3 Pro SE is the only confirmed model; its image paths intentionally remain null until a model photo with permission is supplied. The renderer shows a text fallback for null paths, unknown models, missing views and failed image loads. It never substitutes a different product or fabricates hardware details. No third-party product photos are bundled.

The console may use the approved `reference.svg` as a labeled UI schematic for the exact Viper V3 Pro SE aliases. It is recorded separately from photos, has no writable hotspots, and does not supply assignment capabilities. Unknown models and inventory thumbnails continue to use the existing missing-photo fallback.
