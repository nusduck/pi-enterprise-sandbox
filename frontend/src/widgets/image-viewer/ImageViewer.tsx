/**
 * Full-size image view in a native <dialog>: Esc or a click outside closes it.
 * Used for message image attachments and image artifacts, instead of a new tab.
 */
import { useEffect, useRef } from 'react';
import s from './imageViewer.module.css';

export function ImageViewer({
  image,
  onClose,
}: {
  image: { url: string; name: string; downloadName?: string | null } | null;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (image && !d.open) d.showModal();
    if (!image && d.open) d.close();
  }, [image]);

  return (
    <dialog
      ref={ref}
      className={s.viewer}
      aria-label={image ? `查看图片：${image.name}` : '查看图片'}
      onClose={onClose}
      onClick={(e) => {
        // A click on the backdrop lands on the dialog element itself.
        if (e.target === e.currentTarget) onClose();
      }}
    >
      {image ? (
        <figure className={s.figure}>
          <img src={image.url} alt={image.name} />
          <figcaption>
            <span className={s.name}>{image.name}</span>
            <a className={s.btn} href={image.url} download={image.downloadName || image.name}>下载</a>
            <button type="button" className={s.btn} onClick={onClose}>关闭</button>
          </figcaption>
        </figure>
      ) : null}
    </dialog>
  );
}
