var Module = {};

class FirefoxWorker {
  constructor(settings) {
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
        console.log("Received a frame pair", message.data);
        if (message.data.frameNum == 10) {
          postMessage({ name: "results", results: { mike: "is awesome" }});
        }
        break;
      }
    }
  }
}

addEventListener("message", function onInit(message) {
  if (message.data.name == "init") {
    new FirefoxWorker(message.data.settings);
    removeEventListener("message", onInit);
  }
});