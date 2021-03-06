"use strict";

class Differentiator {
  constructor(videoName, videoURL, numWorkers = 6, debug = false) {
    const WORKER_URL = "differentiator_worker.js";
    this.states = {
      IDLE: Symbol("idle"),
      READY: Symbol("ready"),
      FINDING_DIFFERENCES: Symbol("finding differences"),
      DONE: Symbol("done"),
    };
    this._currentState = this.states.IDLE;

    this._debug = debug;
    if (debug && !window.cv) {
      // Hack hack hack
      let script = document.createElement("script");
      script.setAttribute("type", "application/javascript");
      script.src = "opencv.js";
      document.head.appendChild(script);

      this._debugThreshList = document.createElement("ul");
      document.body.appendChild(this._debugThreshList);
    }

    this._numWorkers = numWorkers;
    this._workers = [];
    this._readyWorkers = 0;
    this._doneWorkers = 0;

    for (let i = 0; i < this._numWorkers; ++i) {
      let worker = new Worker(WORKER_URL);
      worker.postMessage({ name: "init" });
      worker.addEventListener("message", this);
      this._workers.push(worker);
    }

    this._differences = [];
    this._differences[0] = true;
    this._playhead = 0;
    this._numProcessed = 0;

    this._startTime = window.performance.now();

    this._videoName = videoName;
    this._videoURL = videoURL;
    this.waitUntilDone = new Promise((resolve, reject) => {
      this._workerResults = resolve;
      this._workerError = reject;
    });
  }

  handleEvent(message) {
    switch(message.data.name) {
      case "ready": {
        this._readyWorkers++;
        if (this._readyWorkers == this._numWorkers) {
          this.currentState = this.states.READY;
          if (this._readyResolver) {
            this._readyResolver();
          }
        }
        break;
      }

      case "difference": {
        console.assert(this.currentState == this.states.FINDING_DIFFERENCES);
        console.assert(this._callbacks);
        let slotIndex = message.data.frameNum;
        let slot = this._differences[slotIndex];
        console.assert(slot === undefined);

        this._differences[slotIndex] = message.data.rects;
        break;
      }

      case "update": {
        console.assert(this.currentState == this.states.FINDING_DIFFERENCES);
        console.assert(this._progressListener);
        console.assert(this._totalFrameEstimate);
        let slotIndex = message.data.frameNum;
        let slot = this._differences[slotIndex];
        console.assert(slot === undefined ||
                       Array.isArray(slot));
        if (slot === undefined) {
          this._differences[slotIndex] = true;
        }
        this.maybeAdvancePlayhead();
        this._numProcessed++;
        this._progressListener.onFramesProcessed(this._numProcessed, this._totalFrameEstimate);
        break;
      }

      case "finished": {
        this._doneWorkers++;
        if (this._doneWorkers == this._numWorkers) {
          console.log("TOTAL TIME: " + (window.performance.now() - this._startTime));
          this._callbacks.onDone();
          this._workerResults(this._differences);
        }
        break;
      }

      case "error": {
        this._workerError(message.data.error);
        break;
      }
    }
  }

  maybeAdvancePlayhead() {
    let currentSlot = this._differences[this._playhead];
    while (currentSlot !== undefined) {
      if (Array.isArray(currentSlot)) {
        this._callbacks.onDifference({
          frameNum: this._playhead,
          rects: currentSlot,
        });
      }
      this._playhead++;
      currentSlot = this._differences[this._playhead];
    }
  }

  get currentState() {
    return this._currentState;
  }

  set currentState(stateTransition) {
    switch(stateTransition) {
      case this.states.IDLE: {
        throw new Error("Did not expect to transition back to IDLE");
        break;
      }
      case this.states.READY: {
        console.assert(this.currentState == this.states.IDLE);
        break;
      }
      case this.states.FINDING_DIFFERENCES: {
        console.assert(this.currentState == this.states.READY);
        console.assert(this._callbacks);
        break;
      }
      case this.states.DONE: {
        console.assert(this.currentState == this.states.FINDING_DIFFERENCES);
        break;
      }
    }

    this._currentState = stateTransition;
  }

  async go(callbacks, progressListener) {
    this._callbacks = callbacks;
    this._progressListener = progressListener;

    if (this.currentState != this.states.READY) {
      this.log("Waiting for workers to be ready.");
      await new Promise(resolve => {
        this._readyResolver = resolve;
      });
    }
    this.log("Workers are ready.");

    let { video, canvas, ctx, width, height } =
      await this.constructDOMElements(this._videoURL);
    let ended = false;
    video.addEventListener("ended", () => {
      this.log("Video has ended.");
      ended = true;
    }, { once: true });

    this.log(`Video duration is ${video.duration} seconds`);

    const FRAME_RATE = 60; // Playback is at 60fps, regardless of video encoding rate.
    this._totalFrameEstimate = Math.ceil(video.duration * FRAME_RATE);

    let lastFrame = this.getFrame(video, ctx);
    let currentFrame;
    let frameNum = 0;

    this.currentState = this.states.FINDING_DIFFERENCES;

    while (!ended) {
      await video.seekToNextFrame();

      // We might have finished analyzing in the meantime, in which case, abort.
      if (this.currentState === this.states.DONE) {
        break;
      }

      currentFrame = this.getFrame(video, ctx);
      this.sendFramePair(++frameNum, width, height, lastFrame, currentFrame.slice(0));
      progressListener.onFramesDecoded(frameNum, this._totalFrameEstimate);
      lastFrame = currentFrame;
    }

    if (this.currentState !== this.states.DONE) {
      this.sendDone();
    }

    video.remove();
    canvas.remove();

    let results = await this.waitUntilDone;

    this.stop();

    return { filename: this._videoName, results };
  }

  stop() {
    if (this._currentState != this.states.DONE) {
      for (let worker of this._workers) {
        worker.terminate();
      }
      this.currentState = this.states.DONE;
      this._progressListener.onFramesProcessed(this._totalFrameEstimate, this._totalFrameEstimate);
      this.log("Workers have shut down");
      console.log(this._differences);
    }
  }

  async constructDOMElements(videoURL) {
    let video = document.createElement("video");
    let canvas = document.createElement("canvas");
    canvas.style.display = video.style.display = "none";

    document.body.appendChild(video);
    document.body.appendChild(canvas);

    video.src = videoURL;
    await new Promise(resolve => {
      video.addEventListener("loadeddata", resolve, { once: true });
    });

    let width = video.videoWidth;
    let height = video.videoHeight;

    let devRatio = window.devicePixelRatio || 1;
    let ctx = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
    let backingRatio = ctx.webkitBackingStorePixelRatio || 1;

    let ratio = devRatio / backingRatio;
    canvas.width = ratio * width;
    canvas.height = ratio * height;
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    ctx.scale(ratio, ratio);

    return { video, canvas, ctx, width, height };
  }

  getFrame(video, ctx) {
    let width = video.videoWidth;
    let height = video.videoHeight;
    ctx.drawImage(video, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
  }

  sendFramePair(frameNum, width, height, lastFrame, currentFrame) {
    if (this._debug) {
      this.debugFramePair(frameNum, width, height, lastFrame, currentFrame);
    } else {
      let workerIndex = frameNum % this._numWorkers;
      let worker = this._workers[workerIndex];
      worker.postMessage({
        name: "framepair",
        frameNum,
        width,
        height,
        lastFrameBuffer: lastFrame.buffer,
        currentFrameBuffer: currentFrame.buffer,
      }, [
        lastFrame.buffer,
        currentFrame.buffer,
      ]);
      console.assert(!lastFrame.byteLength);
      console.assert(!currentFrame.byteLength);
    }
  }

  sendDone() {
    for (let worker of this._workers) {
      worker.postMessage({
        name: "done",
      });
    }
  }

  log(...args) {
    console.log(`Differentiator: ${this._videoName}: `, ...args);
  }

  debugFramePair(frameNum, width, height, lastFrame, currentFrame) {
    /*if (frameNum < 209 || frameNum > 211) {
      return;
    }*/
    
    if (frameNum != 37) {
      return;
    }

    let lastFrameBuffer = lastFrame.buffer;
    let currentFrameBuffer = currentFrame.buffer;

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

    console.log(`Frame ${frameNum} is different?: ${isDifferent}`);
    let li = document.createElement("li");
    let header = document.createElement("h5");
    header.textContent = `Frame #${frameNum}`;
    li.appendChild(header);

    let lastCanvas = document.createElement("canvas");
    lastCanvas.id = `croptop-debug-id-last-${frameNum}`;
    li.appendChild(lastCanvas);

    let currentCanvas = document.createElement("canvas");
    currentCanvas.id = `croptop-debug-id-current-${frameNum}`;
    li.appendChild(currentCanvas);

    let diffCanvas = document.createElement("canvas");
    diffCanvas.id = `croptop-debug-id-diff-${frameNum}`;
    li.appendChild(diffCanvas);

    let threshCanvas = document.createElement("canvas");
    threshCanvas.id = `croptop-debug-id-thresh-${frameNum}`;
    li.appendChild(threshCanvas);

    let toprightCanvas = document.createElement("canvas");
    toprightCanvas.id = `croptop-debug-topright-${frameNum}`;
    li.appendChild(toprightCanvas);

    this._debugThreshList.appendChild(li);

    cv.imshow(lastCanvas.id, lastFrameMat);
    cv.imshow(currentCanvas.id, currentFrameMat);
    cv.imshow(diffCanvas.id, diff);
    cv.imshow(threshCanvas.id, thresh);

    if (isDifferent) {
      // See if the top-right 50x50 square of the current frame is all white. If so,
      // and if the previous frame's top-right 50x50 square is also different, then
      // consider this the blank frame.
      let rect = new cv.Rect(width - 51, 0, 50, 50);
      let diffTopRight = new cv.Mat();
      diffTopRight = diff.roi(rect);

      cv.threshold(diffTopRight, diffTopRight, 127, 255, cv.THRESH_BINARY);

      let topRightIsDifferent = cv.countNonZero(diffTopRight);
      cv.imshow(toprightCanvas.id, diffTopRight);

      if (topRightIsDifferent) {
        console.log("Top right is different");
        // Check to see if the top right rect is mostly white.
        let currentTopRight = new cv.Mat();
        currentTopRight = currentFrameMat.roi(rect);
        cv.threshold(currentTopRight, currentTopRight, 220, 255, cv.THRESH_BINARY_INV);

        if (cv.countNonZero(currentTopRight) == 0) {
          // It's white!
          console.log("Top right is apparently white - good candidate for first blank");
        }

        diffTopRight.delete();
        currentTopRight.delete();
      } else {
        console.log("Gathering contours");
        let contours = new cv.MatVector();
        let hierarchy = new cv.Mat();
        cv.findContours(thresh, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE);

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

        if (rects.length) {
          console.log(rects);
        }
      }
    }


    thresh.delete();
    currentFrameMat.delete();
    lastFrameMat.delete();
    diff.delete();
  }
}