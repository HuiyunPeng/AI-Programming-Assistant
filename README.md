# AI-Programming-Assistant

## About

TODO

## Prerequisites

Install the following:

1. [Node.js 16](https://nodejs.org/en/about/previous-releases)
2. [Python 3.8](https://www.python.org/downloads/) or above
3. The [`numpy`](https://pypi.org/project/numpy/) Python package
4. The [`matplotlib`](https://pypi.org/project/matplotlib/) Python package
5. [yarn 1.22.x](https://classic.yarnpkg.com/en/)
6. An [OpenAI API key](https://platform.openai.com/docs/api-reference/authentication) to use for generating completions.

## How to Build

### Building from the terminal
The simplest way to build and run LEAP is directly within the terminal. To do so:

1. (Mac users only) Open up a terminal, type `arch` to ensure that you are using a x86_64 architecture. M1 is currently not supported.
2. Navigate to the directory containing this README file.
3. Run `yarn` or `yarn install`. This will install all the necessary node packages. Ensure that this command finishes successfully. If not, please look at the errors and address them before moving on.
4. Run `yarn compile`. This will compile the source code.

## How to Run

Set up these environment variables:

1. `PYTHON3`: Absolute path to the Python 3 executable.
2. `RUNPY`: Absolute path to the `./src/run.py` file.
3. `IMGSUM`: Absolute path to the `./src/img-summary.py` file.
4. `LEAP_PROMPT`: Absolute path to the `./src/implement_it.txt` file.
5. `OPENAI_API_KEY`: Your OpenAI API key.

How you set these variables is up to you (e.g. you could set them globally) but here we include instructions for setting them for running from the terminal, and from VSCode.

### Running from the terminal
We have provided a shell script for running in `./run.sh`. First edit the script in a text editor and replace `OPENAI API KEY HERE` with your OpenAI API key. The other env vars should be set automatically, but if you run into issues, you may want to hard code them in this script as well.

After editing this file, save and close and run it with `./run.sh`. Note that you must [build](#how-to-build) LEAP _before_ running this script, otherwise you will run into errors.

## How to Use
To use this, first open a python file or open a new file and save it with a `.py` extension. Then, as you write executable Python code, you should see Projection Boxes appearing to show your program's runtime values. To invoke the AI assistant, press `Ctrl + Enter` (`Cmd + Enter` on Mac) on a _new line_. This should open a side panel containing code suggestions.
