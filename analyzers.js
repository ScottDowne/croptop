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
