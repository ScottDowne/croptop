var Module = {};

class DifferentiatorWorker {
  constructor() {
    addEventListener("message", this);
    Module._main = () => {
      this.ready();
    }
    importScripts("opencv.js");
  }

  ready() {
    postMessage({ name: "ready"});
  }

  handleEvent(message) {
    switch(message.data.name) {
      case "framepair": {
        let frameNum = message.data.frameNum;
        let width = message.data.width;
        let height = message.data.height;

        let lastFrameBuffer = message.data.lastFrameBuffer;
        let currentFrameBuffer = message.data.currentFrameBuffer;

        let lastFrameMat = new cv.Mat(height, width, cv.CV_8UC4);
        lastFrameMat.data.set(new Uint8Array(lastFrameBuffer));
        cv.cvtColor(lastFrameMat, lastFrameMat, cv.COLOR_BGR2GRAY);

        let currentFrameMat = new cv.Mat(height, width, cv.CV_8UC4);
        currentFrameMat.data.set(new Uint8Array(currentFrameBuffer));
        cv.cvtColor(currentFrameMat, currentFrameMat, cv.COLOR_BGR2GRAY);

        let diff = new cv.Mat(height, width, cv.CV_8UC4);
        cv.absdiff(currentFrameMat, lastFrameMat, diff);

        let thresh = new cv.Mat(height, width, cv.CV_8UC4);
        cv.adaptiveThreshold(diff, thresh, 255, cv.ADAPTIVE_THRESH_GAUSSIAN_C, cv.THRESH_BINARY_INV, 11, 5);

        let isDifferent = cv.countNonZero(thresh);
        if (isDifferent) {
          let contours = new cv.MatVector();
          let hierarchy = new cv.Mat();
          cv.findContours(thresh, contours, hierarchy, cv.RETR_LIST, cv.CHAIN_APPROX_SIMPLE);

          let rects = [];
          for (let i = 0; i < contours.size(); ++i) {
            let rect = cv.boundingRect(contours.get(i));
            rects.push({
              x: rect.x,
              y: rect.y,
              width: rect.width,
              height: rect.height
            });
          }
          contours.delete();
          hierarchy.delete();

          postMessage({ name: "difference", frameNum, rects });
        }

        thresh.delete();
        currentFrameMat.delete();
        lastFrameMat.delete();
        diff.delete();
        postMessage({ name: "update", frameNum });
        break;
      }
      case "done": {
        postMessage({ name: "finished" });
      }
    }
  }
}

addEventListener("message", function onInit(message) {
  if (message.data.name == "init") {
    new DifferentiatorWorker();
    removeEventListener("message", onInit);
  }
});
