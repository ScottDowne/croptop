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

  almostEquals(left, right, epsilon = 3) {
    return Math.abs(left - right) <= epsilon;
  }

  rectQualifies(rect) {
    // Ignore rects for the blinking text cursor
    if (this.almostEquals(rect.width, 10) &&
        this.almostEquals(rect.height, 31)) {
      return false;
    }

    return true;
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
          // See if the top-right 50x50 square of the current frame is all white. If so,
          // and if the previous frame's top-right 50x50 square is also different, then
          // consider this the blank frame.
          let rect = new cv.Rect(width - 51, 0, 50, 50);
          let threshTopRight = new cv.Mat();
          threshTopRight = thresh.roi(rect);

          let topRightIsDifferent = cv.countNonZero(threshTopRight);

          if (topRightIsDifferent) {
            // Check to see if the top right rect is mostly white.
            let currentTopRight = new cv.Mat();
            currentTopRight = currentFrameMat.roi(rect);
            cv.threshold(currentTopRight, currentTopRight, 220, 255, cv.THRESH_BINARY_INV);

            if (cv.countNonZero(currentTopRight) == 0) {
              // It's white!
              postMessage({
                name: "difference",
                frameNum,
                rects: [{
                  x: 0,
                  y: 0,
                  width: 1276,
                  height: 678,
                }],
              });
            }

            threshTopRight.delete();
            currentTopRight.delete();
          } else {
            let contours = new cv.MatVector();
            let hierarchy = new cv.Mat();
            cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

            let rects = [];
            for (let i = 0; i < contours.size(); ++i) {
              let rect = cv.boundingRect(contours.get(i));
              if (this.rectQualifies(rect)) {
                rects.push({
                  x: rect.x,
                  y: rect.y,
                  width: rect.width,
                  height: rect.height
                });
              }
            }
            contours.delete();
            hierarchy.delete();

            if (rects.length) {
              postMessage({ name: "difference", frameNum, rects });
            }
          }
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
