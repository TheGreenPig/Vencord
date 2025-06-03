/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "./styles.css";

import { addMessageAccessory, removeMessageAccessory } from "@api/MessageAccessories";
import { updateMessage } from "@api/MessageUpdater";
import { definePluginSettings } from "@api/Settings";
import ErrorBoundary from "@components/ErrorBoundary";
import { Devs } from "@utils/constants";
import definePlugin, { OptionType, PluginNative } from "@utils/types";
import { Tooltip, useEffect, useRef, useState } from "@webpack/common";

import { LRUCache } from "./cache";

const Native = VencordNative.pluginHelpers.PdfViewer as PluginNative<typeof import("./native")>;

const settings = definePluginSettings({
    autoEmptyCache: {
        type: OptionType.BOOLEAN,
        description: "Automatically remove the cached PDF file when the component is unmounted. Turning this on will increase load times for PDFs that have already been viewed, but may consume less memory.",
        default: false
    },
});

const objectUrlsCache = new LRUCache(20);

let pdfJsLoader: Promise<void> | null = null;
function loadPdfJs(): Promise<void> {
    if (pdfJsLoader) return pdfJsLoader;

    pdfJsLoader = new Promise((resolve, reject) => {
        if ((window as any).pdfjsLib) {
            (window as any).pdfjsLib.GlobalWorkerOptions.workerSrc =
                "https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/build/pdf.worker.min.js";
            return resolve();
        }

        const script = document.createElement("script");
        script.src = "https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/build/pdf.min.js";
        script.defer = true;
        script.onload = () => {
            (window as any).pdfjsLib.GlobalWorkerOptions.workerSrc =
                "https://cdn.jsdelivr.net/npm/pdfjs-dist@2.16.105/build/pdf.worker.min.js";
            resolve();
        };
        script.onerror = () => {
            console.error("Failed to load PDF.js from jsDelivr");
            reject(new Error("PDF.js load failure"));
        };
        document.head.appendChild(script);
    });

    return pdfJsLoader;
}

interface Attachment {
    id: string;
    filename: string;
    size: number;
    url: string;
    proxy_url: string;
    content_type: string;
    content_scan_version: number;
    title: string;
    spoiler: boolean;
    previewBlobUrl?: string;
    previewVisible?: boolean;
}

function FilePreview({ attachment }: { attachment: Attachment; }) {
    const { previewBlobUrl, previewVisible } = attachment;
    const containerRef = useRef<HTMLDivElement>(null);
    const [pdfReady, setPdfReady] = useState(false);

    useEffect(() => {
        if (!previewVisible) return;
        loadPdfJs()
            .then(() => setPdfReady(true))
            .catch(() => {
                containerRef.current!.innerHTML =
                    "<div style='color: red;'>Failed to load PDF.js.</div>";
            });
    }, [previewVisible]);

    // 2) Once PDF.js is loaded and we have a blob URL, render pages
    useEffect(() => {
        if (!previewVisible || !pdfReady || !previewBlobUrl) return;
        const { pdfjsLib } = (window as any);
        if (!pdfjsLib) return;

        const container = containerRef.current!;
        container.innerHTML = ""; // clear previous canvases

        pdfjsLib
            .getDocument(previewBlobUrl)
            .promise.then((pdf: any) => {
                const renderPage = (pageNum: number) => {
                    return pdf.getPage(pageNum).then((page: any) => {
                        const viewport = page.getViewport({ scale: 1.2 });
                        const canvas = document.createElement("canvas");
                        canvas.style.marginBottom = "12px";
                        canvas.width = viewport.width;
                        canvas.height = viewport.height;
                        const ctx = canvas.getContext("2d")!;
                        return page
                            .render({ canvasContext: ctx, viewport })
                            .promise.then(() => {
                                container.appendChild(canvas);
                            });
                    });
                };

                // Render all pages sequentially (or use Promise.all for parallel)
                const promises: Promise<void>[] = [];
                for (let i = 1; i <= pdf.numPages; i++) {
                    promises.push(renderPage(i));
                }
                return Promise.all(promises);
            })
            .catch((err: any) => {
                console.error("Error rendering PDF:", err);
                container.innerHTML =
                    "<div style='color: red;'>Failed to render PDF.</div>";
            });
    }, [previewVisible, pdfReady, previewBlobUrl]);

    if (!previewVisible) return null;

    return (
        <div
            className="vc-pdf-viewer-container"
            style={{
                width: 500,
                height: 500,
            }} >
            {previewBlobUrl && pdfReady ? (
                <div ref={containerRef} className="vc-pdf-viewer-preview"></div>
            ) : (
                <div
                    style={{
                        display: "flex",
                        justifyContent: "center",
                        padding: "16px"
                    }}
                >
                    <div>Loading PDF…</div>
                </div>
            )}
        </div>
    );
}

function PreviewButton({ attachment, channelId, messageId }: { attachment: Attachment; channelId: string; messageId: string; }) {
    const [visible, setVisible] = useState<boolean>(false);
    const [url, setUrl] = useState<string>();

    const initPdfData = async () => {
        const cachedUrl = objectUrlsCache.get(attachment.url);
        if (cachedUrl) {
            setUrl(cachedUrl);
            return;
        }
        try {
            const buffer = await Native.getBufferResponse(attachment.url);

            const file = new File([buffer], attachment.filename, { type: attachment.content_type });
            console.log("FILE", file);

            const blobUrl = URL.createObjectURL(file);
            console.log("Created blob URL for PDF:", blobUrl);
            objectUrlsCache.set(attachment.url, blobUrl);
            setUrl(blobUrl);
        } catch (error) {
            console.log(error);
        }
    };

    useEffect(() => {
        setVisible(visible);
        attachment.previewVisible = visible;
        updateMessage(channelId, messageId);

        if (visible && !url) initPdfData();
    }, [visible]);

    useEffect(() => {
        attachment.previewBlobUrl = url;
        updateMessage(channelId, messageId);
        return () => {
            if (url && settings.store.autoEmptyCache) {
                objectUrlsCache.delete(attachment.url);
            }
        };
    }, [url]);

    return <Tooltip text={visible ? "Hide File Preview" : "Preview File"}>
        {tooltipProps => (
            <div
                {...tooltipProps}
                className="vc-pdf-viewer-toggle"
                role="button"
                onClick={() => {
                    setVisible(v => !v);
                }}
            >
                {/* {visible ? <Icons.EyeSlashIcon /> : < Icons.EyeIcon />} */}
                {visible ? <div>Hide Preview</div> : <div>Show Preview</div>}
            </div>
        )}
    </Tooltip >;
}

export default definePlugin({
    name: "PdfViewer",
    description: "Preview PDF Files without having to download them",
    authors: [Devs.AGreenPig],
    dependencies: ["MessageAccessoriesAPI", "MessageUpdaterAPI",],
    settings,

    patches: [
        {
            find: "Messages.IMG_ALT_ATTACHMENT_FILE_TYPE.format",
            replacement: {
                match: /newMosaicStyle,\i\),children:\[(?<=}=(\i);.+?)/,
                replace: "$&$self.renderPreviewButton($1),"
            }
        }
    ],

    start() {
        addMessageAccessory("pdfViewer", props => {
            const pdfAttachments = props.message.attachments.filter(a => a.content_type === "application/pdf");
            if (!pdfAttachments.length) return null;

            return (
                <ErrorBoundary>
                    {
                        pdfAttachments.map((attachment, index) => (
                            <ErrorBoundary key={index}>
                                <PreviewButton attachment={attachment} channelId={props.message.channel_id} messageId={props.message.id} />
                                <FilePreview attachment={attachment} />
                            </ErrorBoundary>
                        ))
                    }
                </ErrorBoundary>
            );
        }, - 1);

    },

    stop() {
        objectUrlsCache.clear();
        removeMessageAccessory("pdfViewer");
    },

    renderPreviewButton: ErrorBoundary.wrap(e => {
        if (e.item.originalItem.content_type !== "application/pdf") return null;
        return <PreviewButton attachment={e.item.originalItem
        } channelId={e.message.channel_id} messageId={e.message.id} />;
    }, { noop: true }),

});

