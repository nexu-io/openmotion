import { Dialog } from '@base-ui/react/dialog';
import { Button } from 'open-design-ui/button';
import { IconButton } from 'open-design-ui/icon-button';
import { useRef, useState, type ChangeEvent, type DragEvent } from 'react';
import { assetMediaUrl } from '../../../shared/asset-library';
import { FieldInput, FieldTextarea } from '../components/ui/FormField';
import type { useToast } from '../hooks/useToast';
import { useI18n } from '../i18n/I18n';
import { RemixIcon } from '../icons/RemixIcons';
import { uploadLibraryAsset } from '../motion/assetClient';
import { MAX_PRODUCT_IMAGES, readProducts, saveProduct, type StudioProduct, type StudioProductImage } from './productLibrary';

type Draft = { key: string; name: string; url: string; description: string; images: StudioProductImage[] };
const newDraft = (): Draft => ({ key: crypto.randomUUID(), name: '', url: '', description: '', images: [] });

const imageUrl = (image: StudioProductImage) => assetMediaUrl(image.assetId, image.versionId);

/**
 * Product studios start from a product. Like Higgsfield's product picker: a dialog of
 * product cards led by "Add product"; a product added once stays in My products.
 */
export function StudioProductPicker({ selected, onSelect, toast }: {
  selected: StudioProduct | null;
  onSelect(product: StudioProduct): void;
  toast: Pick<ReturnType<typeof useToast>, 'showToast'>;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [products, setProducts] = useState<StudioProduct[]>(readProducts);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const openDialog = () => {
    setProducts(readProducts());
    setDraft(null);
    setOpen(true);
  };

  const addImages = async (files: File[]) => {
    const images = files.filter(file => file.type.startsWith('image/'));
    if (!images.length || !draft) return;
    const draftKey = draft.key;
    const room = MAX_PRODUCT_IMAGES - draft.images.length;
    if (images.length > room) toast.showToast(t('Up to {count} product photos', { count: MAX_PRODUCT_IMAGES }), 'error', 'feedback');
    setUploading(true);
    try {
      const added: StudioProductImage[] = [];
      for (const file of images.slice(0, Math.max(0, room))) {
        try {
          const asset = await uploadLibraryAsset(file);
          added.push({ assetId: asset.id, versionId: asset.currentVersionId, name: asset.name || file.name });
        } catch {
          toast.showToast(t('Could not upload {name}', { name: file.name }), 'error', 'feedback');
        }
      }
      // Photos land only in the draft that started the upload, never in one opened after cancelling it.
      setDraft(current => current && current.key === draftKey ? { ...current, images: [...current.images, ...added].slice(0, MAX_PRODUCT_IMAGES) } : current);
    } finally {
      setUploading(false);
    }
  };

  const onFiles = (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    void addImages(files);
  };

  const onDrop = (event: DragEvent<HTMLElement>) => {
    event.preventDefault();
    setDragging(false);
    void addImages(Array.from(event.dataTransfer.files));
  };

  const choose = (product: StudioProduct) => {
    setOpen(false);
    onSelect(product);
  };

  const save = () => {
    if (!draft) return;
    if (!draft.images.length) { toast.showToast(t('Add at least one product photo'), 'error', 'feedback'); return; }
    if (!draft.name.trim()) { toast.showToast(t('Fill in {field} first', { field: t('Product name') }), 'error', 'feedback'); return; }
    const product: StudioProduct = {
      id: crypto.randomUUID(),
      name: draft.name.trim(),
      url: draft.url.trim(),
      description: draft.description.trim(),
      images: draft.images,
      createdAt: Date.now(),
    };
    setProducts(saveProduct(product));
    toast.showToast(t('Product saved to My products'), 'info', 'feedback');
    choose(product);
  };

  const cover = draft?.images[0];

  return (
    <>
      {selected ? (
        <div className="om-studio-product-selected" data-product-state="selected">
          <span className="om-studio-product-cover" aria-hidden="true">
            {selected.images[0] ? <img src={imageUrl(selected.images[0])} alt="" /> : <RemixIcon name="box-3-line" size={20} />}
          </span>
          <span className="om-studio-product-copy">
            <small>{t('Product')}</small>
            <strong>{selected.name}</strong>
            <span>{selected.url || t('{count} photos', { count: selected.images.length })}</span>
          </span>
          <Button variant="secondary" size="sm" onClick={openDialog}>{t('Change')}</Button>
        </div>
      ) : (
        <Button variant="plain" className="om-studio-product-entry" data-product-state="empty" onClick={openDialog}>
          <span className="om-studio-product-entry-icon" aria-hidden="true"><RemixIcon name="add-line" size={18} /></span>
          <span className="om-studio-product-copy">
            <strong>{t('Add a product')}</strong>
            <span>{t('Start with your product: upload its photos once and reuse them.')}</span>
          </span>
        </Button>
      )}

      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Backdrop className="hf-overlay-backdrop om-scenario-backdrop" />
          <Dialog.Popup className="om-dialog om-studio-product-dialog" data-product-dialog={draft ? 'add' : 'list'} onKeyDown={event => event.stopPropagation()}>
            <header className="om-studio-product-dialog-head">
              {draft && (
                <IconButton variant="ghost" size="sm" aria-label={t('Back')} icon={<RemixIcon name="arrow-left-line" size={16} />}
                  onClick={() => setDraft(null)} />
              )}
              <Dialog.Title className="om-subtitle">{draft ? t('Add a product') : t('My products')}</Dialog.Title>
              <IconButton variant="ghost" size="sm" aria-label={t('Close')} icon={<RemixIcon name="close-line" size={18} />}
                onClick={() => setOpen(false)} />
            </header>

            {draft ? (
              <div className="om-studio-product-form">
                <div className="om-studio-product-media">
                  <Button
                    variant="plain"
                    className="om-studio-product-drop"
                    data-dragging={dragging ? 'true' : undefined}
                    data-has-image={cover ? 'true' : undefined}
                    disabled={uploading}
                    onClick={() => fileInput.current?.click()}
                    onDragOver={event => { event.preventDefault(); setDragging(true); }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={onDrop}
                  >
                    {cover ? <img src={imageUrl(cover)} alt="" /> : (
                      <span className="om-studio-product-drop-empty">
                        <RemixIcon name="upload-2-line" size={24} />
                        <strong>{uploading ? t('Uploading…') : t('Upload product photos')}</strong>
                        <span>{t('Drag photos here · up to {count}', { count: MAX_PRODUCT_IMAGES })}</span>
                      </span>
                    )}
                  </Button>
                  {draft.images.length > 0 && (
                    <div className="om-studio-product-strip">
                      {draft.images.map(image => (
                        <span key={image.assetId} className="om-studio-product-strip-item">
                          <img src={imageUrl(image)} alt="" />
                          <IconButton variant="secondary" size="sm" className="om-studio-product-strip-remove"
                            aria-label={t('Remove {name}', { name: image.name })} icon={<RemixIcon name="close-line" size={12} />}
                            onClick={() => setDraft({ ...draft, images: draft.images.filter(item => item.assetId !== image.assetId) })} />
                        </span>
                      ))}
                      {draft.images.length < MAX_PRODUCT_IMAGES && (
                        <Button variant="plain" className="om-studio-product-strip-add" aria-label={t('Upload product photos')}
                          disabled={uploading} onClick={() => fileInput.current?.click()}>
                          <RemixIcon name="add-line" size={16} />
                        </Button>
                      )}
                    </div>
                  )}
                  <input ref={fileInput} type="file" accept="image/*" multiple hidden onChange={onFiles} />
                </div>
                <div className="om-studio-product-fields">
                  <label>
                    <span>{t('Product name')}</span>
                    <FieldInput maxLength={120} placeholder={t('Holiday Weekender Tote')} value={draft.name}
                      onChange={event => setDraft({ ...draft, name: event.target.value })} />
                  </label>
                  <label>
                    <span>{t('Product link (optional)')}</span>
                    <FieldInput type="url" maxLength={500} placeholder="https://" value={draft.url}
                      onChange={event => setDraft({ ...draft, url: event.target.value })} />
                  </label>
                  <label>
                    <span>{t('Product details (optional)')}</span>
                    <FieldTextarea rows={4} maxLength={1200} placeholder={t('Materials, standout features and why shoppers buy it')}
                      value={draft.description} onChange={event => setDraft({ ...draft, description: event.target.value })} />
                  </label>
                  <div className="om-studio-product-actions">
                    <Button variant="ghost" size="sm" onClick={() => setDraft(null)}>{t('Cancel')}</Button>
                    <Button variant="primary" size="sm" disabled={uploading} onClick={save}>{t('Save product')}</Button>
                  </div>
                </div>
              </div>
            ) : (
              <div className="om-studio-product-grid">
                <Button variant="plain" className="om-studio-product-card om-studio-product-card-add" data-product-add onClick={() => setDraft(newDraft())}>
                  <span className="om-studio-product-card-art"><span className="om-studio-product-entry-icon"><RemixIcon name="add-line" size={18} /></span></span>
                  <strong>{t('Add a product')}</strong>
                </Button>
                {products.map(product => (
                  <Button key={product.id} variant="plain" className="om-studio-product-card" data-product-item={product.id}
                    aria-pressed={selected?.id === product.id} onClick={() => choose(product)}>
                    <span className="om-studio-product-card-art">
                      {product.images[0] ? <img src={imageUrl(product.images[0])} alt="" loading="lazy" /> : <RemixIcon name="box-3-line" size={20} />}
                    </span>
                    <strong>{product.name}</strong>
                  </Button>
                ))}
                {!products.length && (
                  <div className="om-studio-product-empty">
                    <RemixIcon name="box-3-line" size={22} />
                    <strong>{t('No products yet')}</strong>
                    <span>{t('Products you add appear here and work in every product studio.')}</span>
                  </div>
                )}
              </div>
            )}
          </Dialog.Popup>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
