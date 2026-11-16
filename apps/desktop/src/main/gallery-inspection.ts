// Executed in the renderer so measurements describe the actual painted gallery.
export const galleryInspectionScript = String.raw`(() => {
  const gallery = document.querySelector('.catalog-grid, .catalog-list-view');
  if (!gallery) return { available: false, reason: 'GALLERY_NOT_OPEN' };
  const viewport = gallery.getBoundingClientRect();
  const measure = (element) => {
    const rect = element.getBoundingClientRect();
    return { x: Math.round(rect.left - viewport.left + gallery.scrollLeft), y: Math.round(rect.top - viewport.top + gallery.scrollTop), width: Math.round(rect.width), height: Math.round(rect.height) };
  };
  const cards = [...gallery.querySelectorAll('[data-asset-id]')];
  const view = gallery.classList.contains('catalog-masonry') ? 'masonry' : gallery.classList.contains('catalog-justified') ? 'justified' : gallery.classList.contains('catalog-list-view') ? 'list' : 'grid';
  const images = cards.map((card) => {
    const frame = card.querySelector('.catalog-card-image, .catalog-list-thumb');
    const image = frame?.querySelector('img.is-ready, img:not(.catalog-image-previous)');
    const indexedWidth = Number(card.getAttribute('data-index-width')) || null;
    const indexedHeight = Number(card.getAttribute('data-index-height')) || null;
    const decodedWidth = image?.naturalWidth || null;
    const decodedHeight = image?.naturalHeight || null;
    const frameBounds = frame ? measure(frame) : null;
    const imageBounds = image ? measure(image) : null;
    const fit = image ? getComputedStyle(image).objectFit : null;
    const imageRatio = decodedWidth && decodedHeight ? decodedWidth / decodedHeight : null;
    const boxRatio = imageBounds?.height ? imageBounds.width / imageBounds.height : null;
    const scale = imageRatio && imageBounds && (fit === 'contain' || fit === 'cover')
      ? (fit === 'contain' ? Math.min(imageBounds.width / decodedWidth, imageBounds.height / decodedHeight) : Math.max(imageBounds.width / decodedWidth, imageBounds.height / decodedHeight))
      : null;
    const painted = scale && imageBounds ? { width: Math.round(decodedWidth * scale), height: Math.round(decodedHeight * scale) } : imageBounds ? { width: imageBounds.width, height: imageBounds.height } : null;
    const indexedRatio = indexedWidth && indexedHeight ? indexedWidth / indexedHeight : null;
    const ratioMismatch = view === 'masonry' || view === 'justified'
      ? indexedRatio && frameBounds?.height && Math.abs(frameBounds.width / frameBounds.height - indexedRatio) > .03
        ? 'frame-vs-index' : imageRatio && frameBounds?.height && Math.abs(frameBounds.width / frameBounds.height - imageRatio) > .03
          ? 'frame-vs-image' : null
      : null;
    return {
      assetId: card.getAttribute('data-asset-id'),
      fileName: card.querySelector('.catalog-card-meta strong, .catalog-list-cell strong')?.textContent ?? '',
      card: measure(card), frame: frameBounds,
      indexed: { width: indexedWidth, height: indexedHeight },
      decoded: { width: decodedWidth, height: decodedHeight },
      display: { box: imageBounds, painted, objectFit: fit, boxRatio },
      ratioMismatch,
      imageReady: !!image?.classList.contains('is-ready'),
      selected: card.getAttribute('aria-selected') === 'true'
    };
  });
  const groups = [...gallery.querySelectorAll('.catalog-group-heading')].map((heading) => ({
    title: heading.querySelector('strong')?.textContent ?? '',
    count: heading.querySelector('span')?.textContent ?? '',
    bounds: measure(heading)
  }));
  return {
    available: true,
    view,
    loadedCount: Number(gallery.getAttribute('data-loaded-count')) || cards.length,
    mountedCount: cards.length,
    viewport: { width: gallery.clientWidth, height: gallery.clientHeight, scrollTop: gallery.scrollTop, scrollHeight: gallery.scrollHeight },
    groups, images
  };
})()`;
