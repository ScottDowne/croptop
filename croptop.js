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
          const MSPF = 16.67; // ms per frame
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
