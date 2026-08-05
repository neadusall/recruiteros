/**
 * RecruitersOS · LinkedIn Poster · carousel PDF assembly
 *
 * LinkedIn document posts are PDFs; readers swipe the pages like a carousel.
 * This builds that PDF from pre-rendered JPEG slides BY HAND, one image per
 * page, because pulling in a PDF library for four object types is how the
 * npm-prune bundle trap starts (see reference-recruiteros-ops). JPEG streams
 * embed verbatim under /DCTDecode, so the whole file is: catalog, page tree,
 * then per slide a page + a draw-the-image content stream + the image XObject.
 */

export interface CarouselSlideJpeg {
  bytes: Buffer;
  width: number;
  height: number;
}

export function jpegsToPdf(slides: CarouselSlideJpeg[]): Buffer {
  if (!slides.length) throw new Error("carousel_empty");
  const chunks: Buffer[] = [];
  let offset = 0;
  const offsets: number[] = [];
  const push = (b: Buffer | string) => {
    const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, "latin1");
    chunks.push(buf);
    offset += buf.length;
  };

  push("%PDF-1.4\n");
  const n = slides.length;
  // Object ids: 1 catalog, 2 page tree, then per slide i: page 3+3i,
  // content 4+3i, image 5+3i.
  const pageIds = Array.from({ length: n }, (_, i) => 3 + i * 3);

  offsets[1] = offset;
  push(`1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`);
  offsets[2] = offset;
  push(`2 0 obj\n<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${n} >>\nendobj\n`);

  slides.forEach((img, i) => {
    const pid = 3 + i * 3, cid = 4 + i * 3, xid = 5 + i * 3;
    // 2px = 1pt, so a 1080px slide becomes a 540pt page.
    const w = Math.round(img.width / 2), h = Math.round(img.height / 2);
    offsets[pid] = offset;
    push(`${pid} 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /XObject << /Im0 ${xid} 0 R >> >> /Contents ${cid} 0 R >>\nendobj\n`);
    const content = `q ${w} 0 0 ${h} 0 0 cm /Im0 Do Q`;
    offsets[cid] = offset;
    push(`${cid} 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`);
    offsets[xid] = offset;
    push(`${xid} 0 obj\n<< /Type /XObject /Subtype /Image /Width ${img.width} /Height ${img.height} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${img.bytes.length} >>\nstream\n`);
    push(img.bytes);
    push(`\nendstream\nendobj\n`);
  });

  const objCount = 2 + n * 3;
  const xrefAt = offset;
  let xref = `xref\n0 ${objCount + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objCount; i++) xref += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  push(xref);
  push(`trailer\n<< /Size ${objCount + 1} /Root 1 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`);
  return Buffer.concat(chunks);
}
