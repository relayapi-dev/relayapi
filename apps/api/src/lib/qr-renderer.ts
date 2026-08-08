import QRCode from "qrcode";

/** A fixed rendering profile makes equal scan URLs byte-for-byte identical. */
export async function renderQrSvg(scanUrl: string): Promise<string> {
	return QRCode.toString(scanUrl, {
		type: "svg",
		errorCorrectionLevel: "M",
		margin: 4,
		width: 512,
		color: {
			dark: "#000000",
			light: "#ffffff",
		},
	});
}
