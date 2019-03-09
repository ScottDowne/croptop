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
