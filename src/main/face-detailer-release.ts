export const FACE_DETAILER_RELEASE = Object.freeze({
  schema: 1, opencv: '4.13.0' as const,
  wheel: {
    filename: 'opencv_python_headless-4.13.0.92-cp37-abi3-win_amd64.whl', bytes: 40070414,
    sha256: '77a82fe35ddcec0f62c15f2ba8a12ecc2ed4207c17b0902c7a3151ae29f37fb6',
    url: 'https://files.pythonhosted.org/packages/4a/90/b338326131ccb2aaa3c2c85d00f41822c0050139a4bfe723cfd95455bd2d/opencv_python_headless-4.13.0.92-cp37-abi3-win_amd64.whl',
  },
  yoloWheel: {
    filename: 'ultralytics-8.4.104-py3-none-any.whl', bytes: 1413385,
    sha256: '2625e73863b06dd882b4024b7a3a033ce712d200e3de58af5252939fb74aa403',
    url: 'https://files.pythonhosted.org/packages/64/15/543669b21ab8dc8a882cc872620eef7ed40343d7089ac66a8d448645ed5f/ultralytics-8.4.104-py3-none-any.whl',
  },
  illustrated: {
    filename: 'fdetailer_seg_v11.pt', bytes: 20553245,
    sha256: 'cb669b3953c4d0d30f5d50b9ac2da571acb6d1bb91b31ed430cf69b984618fcc',
    revision: 'civitai-1384450', license: 'Publisher permissions: https://civitai.com/models/1228695',
    url: 'https://huggingface.co/ThirdTimesTheCiarc/misc/resolve/667074b2905570cae40078560866447b58087cf6/1228695/1384450/fdetailerAdetailerFor_v11.pt',
  },
  anime: {
    filename: 'lbpcascade_animeface.xml', bytes: 246945,
    sha256: '9376d30ac38db6bda2a68b88b3b76bbd7e6aa33af47f7f5c76bc88ca75f1ce30',
    revision: '4433ab1ae1166ea75acfe99eb0f18709dac329a0', license: 'MIT',
    url: 'https://raw.githubusercontent.com/nagadomi/lbpcascade_animeface/4433ab1ae1166ea75acfe99eb0f18709dac329a0/lbpcascade_animeface.xml',
  },
  photographic: {
    filename: 'face_detection_yunet_2023mar.onnx', bytes: 232589,
    sha256: '8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4',
    revision: '47534e27c9851bb1128ccc0102f1145e27f23f98', license: 'MIT',
    url: 'https://media.githubusercontent.com/media/opencv/opencv_zoo/47534e27c9851bb1128ccc0102f1145e27f23f98/models/face_detection_yunet/face_detection_yunet_2023mar.onnx',
  },
});

// Provenance for existing saved detections; never used for new detection.
export const LEGACY_ILLUSTRATED_DETECTOR = {
    filename: 'face_yolov8m.pt', bytes: 52026019,
    sha256: '717923c19b3f4bbf5250b728f1fa6b2cb72a33aed1d236ea9caf0e21ad943e5f',
    revision: '53cc19de382014514d9d4038601d261a7faa9b7b', license: 'Apache-2.0 (publisher model card)',
    url: 'https://huggingface.co/Bingsu/adetailer/resolve/53cc19de382014514d9d4038601d261a7faa9b7b/face_yolov8m.pt',
  };
