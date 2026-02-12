export type DetectedRegion = {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  source_text: string;
  translated_text: string;
  confidence: number;
};

export type PipelineResponse = {
  image_width: number;
  image_height: number;
  regions: DetectedRegion[];
  inpaint_preview_url?: string;
};
