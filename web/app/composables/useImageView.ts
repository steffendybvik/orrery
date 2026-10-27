// The picture shown larger over the page (ImageView): open or closed.
export function useImageView() {
    const image = useState<{src: string, alt: string} | null>('image-view', () => null)
    const open = (src: string, alt: string) => image.value = {src, alt}
    const close = () => image.value = null
    return {image, open, close}
}
