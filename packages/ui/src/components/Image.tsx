interface ImageProps {
  hoverImageId?: string;
  imageId: string;
  isButton: boolean;
  height?: string;
  width?: string;
}
export default function Image(props: ImageProps) {
  const { hoverImageId, imageId, isButton, height = "auto", width = "auto" } = props;
  return (
    <>
      <img src={`https://images.web3auth.io/${imageId}.svg`} height={height} width={width} alt={imageId} className="image-icon" />
      {isButton ? (
        <img src={`https://images.web3auth.io/${hoverImageId}.svg`} height={height} width={28} alt={imageId} className="hover-icon" />
      ) : null}
    </>
  );
}
