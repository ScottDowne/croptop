class Analyzer {
  constructor(videoName, videoURL, workerType, workerSettings) {
    this._currentState = this.states.IDLE;
    let workerURL = `worker_${workerType}.js`;
    this._worker = new Worker(workerURL);
    this._worker.postMessage({ name: "init", settings: workerSettings });
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
        this._currentState = this.states.READY;
        if (this._readyResolver) {
          this._readyResolver();
        }
        break;
      }

      case "results": {
        this._workerResults(message.data.results);
        break;
      }

      case "error": {
        this._workerError(message.data.error);
        break;
      }
    }
  }

  get states() {
    return {
      IDLE: Symbol("idle"),
      READY: Symbol("ready"),
      FINDING_ORIGIN: Symbol("finding origin"),
      FINDING_KEY_TIMESTAMPS: Symbol("finding key timestamps"),
      DONE: Symbol("done"),
    }
  }

  get currentState() {
    return this._currentState;
  }

  async go() {
    if (this.currentState != this.states.READY) {
      this.log("Waiting for worker to be ready.");
      await new Promise(resolve => {
        this._readyResolver = resolve;
      });
    }
    this.log("Worker is ready.");

    let { video, canvas, ctx } = await this.constructDOMElements(this._videoURL);
    let ended = false;
    video.addEventListener("ended", () => {
      ended = true;
    }, { once: true });

    let lastFrame = this.getFrame(video, ctx);
    let frameNum = 0;

    while (!ended && frameNum < 15) {
      await video.seekToNextFrame();
      let currentFrame = this.getFrame(video, ctx);
      this.sendFramePair(++frameNum, lastFrame, currentFrame.slice(0));
      lastFrame = currentFrame;
    }

    video.remove();
    canvas.remove();

    let results = await this.waitUntilDone;
    return { filename: this._videoName, results };
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

    return { video, canvas, ctx };
  }

  getFrame(video, ctx) {
    let width = video.videoWidth;
    let height = video.videoHeight;
    ctx.drawImage(video, 0, 0, width, height);
    return ctx.getImageData(0, 0, width, height).data;
  }

  sendFramePair(frameNum, lastFrame, currentFrame) {
    this._worker.postMessage({
      name: "framepair",
      frameNum,
    }, [
      lastFrame.buffer,
      currentFrame.buffer,
    ]);
  }

  log(...args) {
    console.log(`${this._videoName}: `, ...args);
  }
}

class CropTop {
  init() {
    this.files = [];
    this.promises = [];

    this.getters = [
      "dropzone",
      "list",
      "logger",
      "start",
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
        if (event.target == this.$start) {
          this.start();
        }
        break;
      }
    }
  }

  onDrop(event) {
    event.stopPropagation();
    event.preventDefault();

    let files = event.dataTransfer.files;
    this.files = [];
    this.$list.innerHTML = "";

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
      file.analyzer = new Analyzer(file.filename, file.url, "firefox", {});
      this.promises.push(file.analyzer.go());
    }

    Promise.all(this.promises).then((results) => {
      console.log("DONE", results);
    });
  }
};

addEventListener("load", () => {
  new CropTop().init();
}, { once: true });