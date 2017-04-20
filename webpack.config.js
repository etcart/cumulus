'use strict';

const path = require('path');
const CopyWebpackPlugin = require('copy-webpack-plugin');

module.exports = {
  entry: {
    lambda: './app/lambda.js',
    local: './app/local.js'
  },
  target: 'node',
  output: {
    filename: '[name].js',
    path: path.resolve(__dirname, 'dist'),
    library: '[name]',
    libraryTarget: 'commonjs2'
  },
  plugins: [new CopyWebpackPlugin([
    {
      from: 'app/views',
      to: 'views'
    }, {
      from: 'public',
      to: 'public'
    }
  ])],
  devtool: 'source-map',
  module: {
    rules: [
      {
        test: /\.js$/,
        exclude: /node_modules/,
        use: {
          loader: 'babel-loader',
          options: {
            cacheDirectory: true
          }
        }
      }, {
        test: /\.html$/,
        use: [
          {
            loader: 'html-loader',
            options: {
              interpolate: true
            }
          }
        ]
      }, {
        test: /\.md$/,
        use: [
          {
            loader: 'html-loader'
          }, {
            loader: 'markdown-loader',
            options: {
              /* your options here */
            }
          }
        ]
      }
    ]
  }
};
