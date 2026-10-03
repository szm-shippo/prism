export const LOCAL_MODEL = {
  id: 'Xenova/paraphrase-multilingual-MiniLM-L12-v2',
  revision: '2c4055b12046f11709e9df2c122e59ffbdc2f900',
  dimensions: 384,
};
export const LOCAL_MODEL_KEY = `local:${LOCAL_MODEL.id}@${LOCAL_MODEL.revision}:q8:mean:l2`;
export const MODEL_FILES = [
  { name: 'config.json', size: 673, hash: '05b570bff786faa5c4604152aa16f19f77ed6dfc31e47dd0f3dd987078693ac7' },
  { name: 'tokenizer_config.json', size: 496, hash: '3f5961b9ac86288cccdb97f32fb848d6187c78e1603958c53f3ea1f296b7d8a2' },
  { name: 'special_tokens_map.json', size: 280, hash: '06e405a36dfe4b9604f484f6a1e619af1a7f7d09e34a8555eb0b77b66318067f' },
  { name: 'tokenizer.json', size: 17082913, hash: 'b60b6b43406a48bf3638526314f3d232d97058bc93472ff2de930d43686fa441' },
  { name: 'onnx/model_quantized.onnx', size: 118308126, hash: '66fc00f5f29afcaff34092e1bdd20008ca3918265a82fb9695a551e510cc4ebc' },
];
