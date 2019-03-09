"use strict";

class Differentiator {
  constructor(videoName, videoURL, frameRate) {
    const WORKER_URL = "differentiator_worker.js";
    this.states = {
      IDLE: Symbol("idle"),
      READY: Symbol("ready"),
      FINDING_DIFFERENCES: Symbol("finding differences"),
      DONE: Symbol("done"),
    };
    this._currentState = this.states.IDLE;

    this._worker = new Worker(WORKER_URL);
    this._worker.postMessage({ name: "init" });
    this._worker.addEventListener("message", this);
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
        this.currentState = this.states.READY;
        if (this._readyResolver) {
          this._readyResolver();
        }
        break;
      }

      case "difference": {
        console.assert(this.currentState == this.states.FINDING_DIFFERENCES);
        console.assert(this._callbacks);
        let difference = {
          frameNum: message.data.frameNum,
          rects: message.data.rects,
        };
        this._callbacks.onDifference(difference);
        break;
      }

      case "update": {
        console.assert(this.currentState == this.states.FINDING_DIFFERENCES);
        console.assert(this._progressListener);
        console.assert(this._totalFrameEstimate);
        this._progressListener.onFramesProcessed(message.data.frameNum, this._totalFrameEstimate);
        break;
      }

      case "finished": {
        this._callbacks.onDone();
        this._workerResults(message.data.results);
        break;
      }

      case "error": {
        this._workerError(message.data.error);
        break;
      }
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
      this.log("Waiting for worker to be ready.");
      await new Promise(resolve => {
        this._readyResolver = resolve;
      });
    }
    this.log("Worker is ready.");

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
      this._worker.terminate();
      this.currentState = this.states.DONE;
      this._progressListener.onFramesProcessed(this._totalFrameEstimate, this._totalFrameEstimate);
      this.log("Worker has shut down");
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
    this._worker.postMessage({
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

  sendDone() {
    this._worker.postMessage({
      name: "done",
    });
  }

  log(...args) {
    console.log(`Differentiator: ${this._videoName}: `, ...args);
  }
}