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

class Analyzer {
  static Factory(type, filename, differentiator, mode, progressListener) {
    if (type == "firefox") {
      return new FirefoxAnalyzer(filename, differentiator, mode, progressListener);
    } else {
      throw new Error(`Don't know how to analyze for type ${type}`);
    }
  }
}

Analyzer.FIND_ONLY_LAUNCH = Symbol("Find only launch frame");
Analyzer.SCAN_NORMAL = Symbol("Find the normal timeline events");
Analyzer.LAUNCH_SQUARE_WIDTH = 23;
Analyzer.LAUNCH_SQUARE_HEIGHT = 23;
Analyzer.LAUNCH_SQUARE_X = 1883;
Analyzer.LAUNCH_SQUARE_Y = 1038;
Analyzer.EVENT_LAUNCH = Symbol("Process launch");
Analyzer.EVENT_FIRST_BLANK = Symbol("First blank paint");
Analyzer.EVENT_SETTLED = Symbol("UI settled");

class FirefoxAnalyzer {
  constructor(filename, differentiator, mode, progressListener) {
    this.states = {
      FINDING_LAUNCH: Symbol("Finding launch frame"),
      FINDING_FIRST_BLANK: Symbol("Finding first blank frame"),
      FINDING_SETTLED: Symbol("Finding the last frame with difference"),
      DONE: Symbol("Done"),
    }

    this.FIRST_BLANK_WIDTH = 1276;
    this.FIRST_BLANK_HEIGHT = 678;

    this._currentState = this.states.FINDING_LAUNCH;

    this._filename = filename;
    this._differentiator = differentiator;
    this._progressListener = progressListener;

    this._differences = [];
    this._promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });

    this._timeline = {};

    this._mode = mode;
    this.log("Running in mode", mode);
  }

  async go() {
    this._differentiatorPromise = this._differentiator.go({
      onDifference: this.onDifference.bind(this),
      onDone: this.onDifferentiatorDone.bind(this),
    }, this._progressListener);

    let timeline = await this._promise;
    return {
      filename: this._filename,
      timeline,
    };
  }

  stop() {
    this.currentState = this.states.DONE;
  }

  get currentState() {
    return this._currentState;
  }

  set currentState(state) {
    switch (state) {
      case this.states.FINDING_LAUNCH: {
        throw new Error("Should not be able to go back to FINDING_LAUNCH state");
        break;
      }
      case this.states.FINDING_FIRST_BLANK: {
        console.assert(this.currentState === this.states.FINDING_LAUNCH);
        this.log("Entering FINDING_FIRST_BLANK state");
        break;
      }
      case this.states.DONE: {
        // We're done here
        this.log("Entering DONE state", this._timeline);
        this._resolve(this._timeline);
        this._differentiator.stop();
        break;
      }
    }
    this._currentState = state;
  }

  updateTimeline(event, value) {
    console.assert(this.currentState != this.states.DONE);
    console.assert(this._progressListener);
    this._timeline[event] = value;
    this._progressListener.onTimelineEvent(event, value);
  }

  almostEqual(left, right, epsilon = 3) {
    return Math.abs(left - right) <= epsilon;
  }

  probablyLaunchFrame(rect) {
    if (this.almostEqual(rect.width, Analyzer.LAUNCH_SQUARE_WIDTH) &&
        this.almostEqual(rect.height, Analyzer.LAUNCH_SQUARE_HEIGHT) &&
        this.almostEqual(rect.x, Analyzer.LAUNCH_SQUARE_X) &&
        this.almostEqual(rect.y, Analyzer.LAUNCH_SQUARE_Y)) {
      return true;
    }
    return false;
  }

  onDifference(difference) {
    this.log(difference);
    this._differences.push(difference);

    for (let rect of difference.rects) {
      switch(this.currentState) {
        case this.states.FINDING_LAUNCH: {
          if (this.probablyLaunchFrame(rect)) {
            this.log(`Found launch frame at ${difference.frameNum}`);
            this.updateTimeline(Analyzer.EVENT_LAUNCH, difference.frameNum);
            if (this._mode === Analyzer.FIND_ONLY_LAUNCH) {
              this.currentState = this.states.DONE;
            } else {
              this.currentState = this.states.FINDING_FIRST_BLANK;
            }
          }
          break;
        }

        case this.states.FINDING_FIRST_BLANK: {
          if (rect.width >= this.FIRST_BLANK_WIDTH &&
              rect.height >= this.FIRST_BLANK_HEIGHT) {
            this.log(`Found first blank frame at ${difference.frameNum}`);
            this.updateTimeline(Analyzer.EVENT_FIRST_BLANK, difference.frameNum);
            this.currentState = this.states.FINDING_SETTLED;
          }

          break;
        }

        case this.states.FINDING_SETTLED: {
          this._lastDifferenceFrame = difference.frameNum;
        }
      }

      if (this.currentState === this.states.DONE) {
        break;
      }
    }
  }

  onDifferentiatorDone() {
    this.log("Found last difference frame: " + this._lastDifferenceFrame);
    this.updateTimeline(Analyzer.EVENT_SETTLED, this._lastDifferenceFrame);
    this.currentState = this.states.DONE;
  }

  log(...args) {
    console.log(`FirefoxAnalyzer: ${this._filename}:`, ...args);
  }
}

class VideoCropper {
  constructor(videoName, videoURL) {
    this._videoName = videoName;
    this._videoURL = videoURL;
  }

  async crop(cropFrom) {
    let video = await this.constructDOMElements(this._videoURL);
    let frame = 0;
    this.log("Seeking to ", cropFrom);
    while (frame < cropFrom) {
      await video.seekToNextFrame();
      frame++;
    }
    this.log("Done seeking");

    await video.play();
    let stream = video.mozCaptureStreamUntilEnded();

    let ended = new Promise(resolve => {
      video.addEventListener("ended", resolve, { once: true });
    });

    let recordedChunks = [];
    let options = {
      mimeType: "video/webm; codecs=vp8",
      videoBitesPerSecond: 10000000,
    };
    let recorder = new MediaRecorder(stream, options);

    let handleDataAvailable = (event) => {
      if (event.data.size > 0) {
        this.log("Pushing data with size", event.data.size);
        recordedChunks.push(event.data);
      }
    };

    recorder.ondataavailable = handleDataAvailable;
    recorder.start();

    this.log(recorder.state);

    this.log("Waiting until end of video");
    await ended;
    this.log("Video ended - stopping recorder...");
    let recorderStopped = new Promise(resolve => {
      recorder.addEventListener("stop", resolve, { once: true });
    });
    recorder.stop();
    await recorderStopped;
    this.log("Recorder stopped");

    let blob = new Blob(recordedChunks, {
      type: "video/webm",
    });
    this.log("Creating object URL");
    let url = URL.createObjectURL(blob);
    video.remove();

    this.log("URL", url);
    return url;
  }

  async constructDOMElements(videoURL) {
    let video = document.createElement("video");
    document.body.appendChild(video);

    video.src = videoURL;
    await new Promise(resolve => {
      video.addEventListener("loadeddata", resolve, { once: true });
    });

    return video;
  }

  log(...args) {
    console.log(`Cropper for ${this._videoName}:`, ...args);
  }
}

const MSPF = 16.67; // ms per frame

class CropTop {
  init() {
    this.files = [];
    this.promises = [];
    this.analyzers = [];

    this.getters = [
      "dropzone",
      "list",
      "logger",
      "start",
      "stop",
      "resultsbody",
    ];

    for (let id of this.getters) {
      this["$" + id] = document.getElementById(id);
    }

    this.$dropzone.addEventListener("dragenter", this);
    this.$dropzone.addEventListener("dragover", this);
    this.$dropzone.addEventListener("drop", this);
    this.$start.addEventListener("click", this);
  }

  handleEvent(event) {
    switch (event.type) {
      case "dragenter":
        // Fall-through
      case "dragover": {
        if (event.target == this.$dropzone) {
          event.stopPropagation();
          event.preventDefault();
          break;
        }
      }

      case "drop": {
        if (event.target == this.$dropzone) {
          this.onDrop(event);
        }
        break;
      }
      case "click": {
        switch (event.target) {
          case this.$start: {
            this.start();
            break;
          }
          case this.$stop: {
            this.stop();
            break;
          }
        }
        break;
      }
    }
  }

  onDrop(event) {
    event.stopPropagation();
    event.preventDefault();

    let files = event.dataTransfer.files;

    for (let file of files) {
      if (!file.type.includes("video")) {
        console.warn(`File ${file.name} doesn't appear to be a video. Skipping.`);
        continue;
      }

      let li = document.createElement("li");
      li.textContent = file.name;
      this.$list.appendChild(li);
      this.files.push({ filename: file.name, url: URL.createObjectURL(file) });
    }
  }

  start() {
    console.log("Booting up analyzers...");
    for (let file of this.files) {

      let tr = document.createElement("tr");

      let filenameCol = document.createElement("td");
      filenameCol.textContent = file.filename;
      tr.appendChild(filenameCol);

      let decodedFramesCol = document.createElement("td");
      let decodedFramesProgress = document.createElement("progress");
      decodedFramesProgress.value = 0;
      decodedFramesProgress.max = 1;

      decodedFramesCol.appendChild(decodedFramesProgress);
      tr.appendChild(decodedFramesCol);

      let processFramesCol = document.createElement("td");
      let processFramesProgress = document.createElement("progress");
      processFramesProgress.value = 0;
      processFramesProgress.max = 1;
      processFramesCol.appendChild(processFramesProgress);
      tr.appendChild(processFramesCol);

      let launchCol = document.createElement("td");
      launchCol.textContent = "?";
      tr.appendChild(launchCol);

      let firstBlankCol = document.createElement("td");
      firstBlankCol.textContent = "?";
      tr.appendChild(firstBlankCol);

      let settledCol = document.createElement("td");
      settledCol.textContent = "?";
      tr.appendChild(settledCol);

      let croppedCol = document.createElement("td");
      let croppedLink = document.createElement("a");
      croppedCol.appendChild(croppedLink);
      tr.appendChild(croppedCol);

      this.$resultsbody.appendChild(tr);

      let progressListener = {
        _origin: 0,

        onFramesDecoded(current, totalEstimate) {
          decodedFramesProgress.value = current;
          decodedFramesProgress.max = totalEstimate;
        },

        onFramesProcessed(current, totalEstimate) {
          processFramesProgress.value = current;
          processFramesProgress.max = totalEstimate;
        },

        onTimelineEvent(timelineEvent, value) {
          switch(timelineEvent) {
            case Analyzer.EVENT_LAUNCH: {
              launchCol.textContent = value;
              this._origin = value;
              break;
            }
            case Analyzer.EVENT_FIRST_BLANK: {
              let time = Math.ceil((value - this._origin) * MSPF);
              firstBlankCol.textContent = time;
              break;
            }
            case Analyzer.EVENT_SETTLED: {
              let time = Math.ceil((value - this._origin) * MSPF);
              settledCol.textContent = time;
              break;
            }
          }
        }
      };

      let differentiator = new Differentiator(file.filename, file.url);

      file.analyzer = Analyzer.Factory("firefox", file.filename,
                                       differentiator, Analyzer.SCAN_NORMAL,
                                       progressListener);
      this.analyzers.push(file.analyzer);
      let runAnalyzer = async () => {
        console.log("Running analyzer");
        let results = await file.analyzer.go();
        console.log("Creating cropper");
        let cropper = new VideoCropper(file.filename, file.url);
        const CROP_BUFFER = 15;
        let cropFrame = results.timeline[Analyzer.EVENT_LAUNCH] - CROP_BUFFER;
        console.log("Cropping to frame " + cropFrame);
        let croppedVideoURL = await cropper.crop(cropFrame);
        console.log("Done crop - got URL: " + croppedVideoURL);
        croppedLink.href = croppedVideoURL;
        croppedLink.textContent = "[Cropped]";
        return results;
      };
      this.promises.push(runAnalyzer());
    }

    Promise.all(this.promises).then((results) => {
      console.log("DONE", results);
    });
  }

  stop() {
    for (let analyzer of this.analyzers) {
      this.analyzer.stop();
    }
  }
};

addEventListener("load", () => {
  new CropTop().init();
}, { once: true });