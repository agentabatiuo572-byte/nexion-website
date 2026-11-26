/** Product artwork is shared by the public cards and the read-only Admin preview. */
export const PRODUCT_IMAGES: Readonly<Record<string, string | undefined>> = {
  phone: '/devices/phone.webp',
  'cloud-share': '/devices/uvel-20261125-web/01-cloud-share.png',
  s1: '/devices/uvel-20261125-web/02-s100.png',
  pro: '/devices/uvel-20261125-web/04-s300.png',
  'pro-v2': '/devices/uvel-20260927-web/stellarbox-pro-v2.png',
  'rack-p1': '/devices/uvel-20261125-web/06-rack-p100.png',
  'rack-p2': '/devices/uvel-20260927-web/stellarrack-p2.png',
};

// The desktop deck has shallower image slots than the static 3:2 layout.
export const PRODUCT_WIDE_IMAGES: Readonly<Record<string, string | undefined>> = {
  'cloud-share': '/devices/uvel-20261125-web/01-cloud-share-wide.png',
  s1: '/devices/uvel-20261125-web/02-s100-wide.png',
  pro: '/devices/uvel-20261125-web/04-s300-wide.png',
  'pro-v2': '/devices/uvel-20260927-web/stellarbox-pro-v2-wide.png',
  'rack-p1': '/devices/uvel-20261125-web/06-rack-p100-wide.png',
  'rack-p2': '/devices/uvel-20260927-web/stellarrack-p2-wide.png',
};
