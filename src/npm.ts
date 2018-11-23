import * as path from 'path';
import * as fs from 'fs';
import * as cp from 'child_process';
import * as _ from 'lodash';
import { CancellationToken } from './util';

// set child_process.exec() stdout buffer to 1MB (200KB by default)
const maxBuffer = 1024 * 1024;

interface IOptions {
	cwd?: string;
	stdio?: any;
	customFds?: any;
	env?: any;
	timeout?: number;
	maxBuffer?: number;
	killSignal?: string;
}

function parseStdout({ stdout }: { stdout: string }): string {
	return stdout.split(/[\r\n]/).filter(line => !!line)[0];
}

function exec(command: string, options: IOptions = {}, cancellationToken?: CancellationToken): Promise<{ stdout: string; stderr: string; }> {
	return new Promise((c, e) => {
		let disposeCancellationListener: Function = null;

		const child = cp.exec(command, { ...options, encoding: 'utf8' } as any, (err, stdout: string, stderr: string) => {
			if (disposeCancellationListener) {
				disposeCancellationListener();
				disposeCancellationListener = null;
			}

			if (err) { return e(err); }
			c({ stdout, stderr });
		});

		if (cancellationToken) {
			disposeCancellationListener = cancellationToken.subscribe(err => {
				child.kill();
				e(err);
			});
		}
	});
}

function checkNPM(cancellationToken?: CancellationToken): Promise<void> {
	return exec('npm -v', {}, cancellationToken).then(({ stdout }) => {
		const version = stdout.trim();

		if (/^3\.7\.[0123]$/.test(version)) {
			return Promise.reject(`npm@${version} doesn't work with vsce. Please update npm: npm install -g npm`);
		}
	});
}

function getNpmDependencies(cwd: string): Promise<string[]> {
	return checkNPM()
		.then(() => exec('npm list --production --parseable --depth=99999', { cwd, maxBuffer }))
		.then(({ stdout }) => stdout
			.split(/[\r\n]/)
			.filter(dir => path.isAbsolute(dir)));
}

interface YarnTreeNode {
	name: string;
	children: YarnTreeNode[];
}

export interface YarnDependency {
	name: string;
	version: string;
	path: string;
	children: YarnDependency[];
}

function asYarnDependency(prefix: string, tree: YarnTreeNode, prune: boolean): YarnDependency | null {
	if (prune && /@[\^~]/.test(tree.name)) {
		return null;
	}

	return walk([path.resolve(prefix)], tree);
}

// yarn list on top level, but not there actually, maybe due to flattening
let orphans = {};
function walk(crumbs, node) {
	let name = node.name;
	let version = name.substr(name.lastIndexOf('@') + 1);
	name = name.substr(0, name.lastIndexOf('@'));
	let depPath = findDep(crumbs, name);
	if (!depPath) {
		orphans[node.name] = node;
		return null;
	}
	let children = [];
	(node.children || []).forEach(child => {
		if (orphans[child.name]) {
			child = orphans[child.name];
		}
		let subDep = walk(crumbs.concat([name]), child);
		if (subDep) {
			children.push(subDep);
		}
	});

	return { name, version, path: depPath, children };
}

function findDep(crumbs, name) {
	let history = crumbs.slice();
	while (history.length > 0) {
		let joinedPath = history.concat([name]).join('/node_modules/');
		let dir = path.resolve(joinedPath);
		if (!fs.existsSync(dir)) {
			history.pop();
			continue;
		}

		return dir;
	}
}

function selectYarnDependencies(deps: YarnDependency[], packagedDependencies: string[]): YarnDependency[] {

	const index = new class {
		private data: { [name: string]: YarnDependency } = Object.create(null);
		constructor() {
			for (const dep of deps) {
				if (this.data[dep.name]) {
					throw Error(`Dependency seen more than once: ${dep.name}`);
				}
				this.data[dep.name] = dep;
			}
		}
		find(name: string): YarnDependency {
			let result = this.data[name];
			if (!result) {
				throw new Error(`Could not find dependency: ${name}`);
			}
			return result;
		}
	};

	const reached = new class {
		values: YarnDependency[] = [];
		add(dep: YarnDependency): boolean {
			if (this.values.indexOf(dep) < 0) {
				this.values.push(dep);
				return true;
			}
			return false;
		}
	};

	const visit = (name: string) => {
		let dep = index.find(name);
		if (!reached.add(dep)) {
			// already seen -> done
			return;
		}
		for (const child of dep.children) {
			visit(child.name);
		}
	};
	packagedDependencies.forEach(visit);
	return reached.values;
}

async function getYarnProductionDependencies(cwd: string, packagedDependencies?: string[]): Promise<YarnDependency[]> {
	const raw = await new Promise<string>((c, e) => cp.exec('yarn list --prod --json', { cwd, encoding: 'utf8', maxBuffer, env: { ...process.env } }, (err, stdout) => err ? e(err) : c(stdout)));
	const match = /^{"type":"tree".*$/m.exec(raw);

	if (!match || match.length !== 1) {
		throw new Error('Could not parse result of `yarn list --json`');
	}

	const usingPackagedDependencies = Array.isArray(packagedDependencies);
	const trees = JSON.parse(match[0]).data.trees as YarnTreeNode[];

	let result = trees
		.slice()
		.reverse()
		.map(tree => asYarnDependency(path.join(cwd), tree, !usingPackagedDependencies))
		.filter(dep => !!dep);

	if (usingPackagedDependencies) {
		result = selectYarnDependencies(result, packagedDependencies);
	}

	return result;
}

async function getYarnDependencies(cwd: string, packagedDependencies?: string[]): Promise<string[]> {
	const result: string[] = [cwd];

	if (await new Promise(c => fs.exists(path.join(cwd, 'yarn.lock'), c))) {
		const deps = await getYarnProductionDependencies(cwd, packagedDependencies);
		const flatten = (dep: YarnDependency) => { result.push(dep.path); dep.children.forEach(flatten); };
		deps.forEach(flatten);
	}

	return _.uniq(result);
}

export function getDependencies(cwd: string, useYarn = false, packagedDependencies?: string[]): Promise<string[]> {
	return useYarn ? getYarnDependencies(cwd, packagedDependencies) : getNpmDependencies(cwd);
}

export function getLatestVersion(name: string, cancellationToken?: CancellationToken): Promise<string> {
	return checkNPM(cancellationToken)
		.then(() => exec(`npm show ${name} version`, {}, cancellationToken))
		.then(parseStdout);
}
