import { Field } from "../field";
import { Grid } from "../grid";
import {
    Array2D,
    BoolArray2D,
    BoolArray2DRow,
} from "../helpers/datastructures";
import { Helper } from "../helpers/helper";
import { SymmetryHelper } from "../helpers/symmetry";
import { Observation } from "../observation";
import { Rule } from "../rule";
import { Search } from "../search";
import { AllNode } from "./all";
import { Node } from "./node";

export abstract class RuleNode extends Node {
    public rules: Rule[];
    public counter: number;
    public steps: number;

    protected matches: [number, number, number, number][];
    protected matchCount: number;
    protected lastMatchedTurn: number;
    protected matchMask: BoolArray2D;

    protected potentials: Array2D<Int32Array>;
    public fields: Field[];
    protected observations: Observation[];
    protected temperature: number;

    protected search: boolean;
    protected futureComputed: boolean;
    protected future: Int32Array;
    protected trajectory: Array2D<Uint8Array>; // TODO: maybe not array2d

    private limit: number;
    private depthCoefficient: number;

    public last: Uint8Array;

    protected override load(
        elem: Element,
        parentSymmetry: Uint8Array,
        grid: Grid
    ) {
        const symmetryString = elem.getAttribute("symmetry");
        const symmetry = SymmetryHelper.getSymmetry(
            grid.MZ === 1,
            symmetryString,
            parentSymmetry
        );
        if (!symmetry) {
            console.error(elem, `unknown symmetry ${symmetryString}`);
            return null;
        }

        const ruleList: Rule[] = [];
        const rules = Helper.collectionToArr(elem.getElementsByTagName("rule"));
        const ruleElements = rules.length > 0 ? rules : [elem];
        for (const e of ruleElements) {
            const rule = Rule.load(e, grid, grid);
            if (!rule) return false;
            rule.original = true;

            const ruleSymmetryString = e.getAttribute("symmetry");
            const ruleSymmetry = SymmetryHelper.getSymmetry(
                grid.MZ === 1,
                ruleSymmetryString,
                symmetry
            );
            if (!ruleSymmetry) {
                console.error(e, `unknown rule symmetry ${ruleSymmetryString}`);
                return null;
            }
            for (const r of rule.symmetries(ruleSymmetry, grid.MZ === 1))
                ruleList.push(r);
        }
        this.rules = ruleList.concat([]);
        this.last = new Uint8Array(rules.length);

        this.steps = parseInt(elem.getAttribute("steps")) || 0;
        this.temperature = parseFloat(elem.getAttribute("temperature")) || 0;

        const efields = Helper.collectionToArr(
            elem.getElementsByTagName("field")
        );
        if (efields.length) {
            this.fields = Array.from({ length: grid.alphabet_size });
            for (const efield of efields)
                this.fields[
                    grid.values.get(parseInt(efield.getAttribute("for")))
                ] = new Field(efield, grid);
            this.potentials = new Array2D(
                Int32Array,
                grid.alphabet_size,
                grid.state.length
            );
            this.potentials.fill(0);
        }

        const eobs = Helper.collectionToArr(
            elem.getElementsByTagName("observe")
        );
        if (eobs.length) {
            this.observations = Array.from({ length: grid.alphabet_size });
            for (const eob of eobs) {
                const value = grid.values.get(
                    parseInt(eob.getAttribute("value"))
                );
                this.observations[value] = new Observation(
                    parseInt(eob.getAttribute("from")) ||
                        grid.characters.charCodeAt(value),
                    eob.getAttribute("to"),
                    grid
                );
            }
        }

        return true;
    }

    public override reset() {
        this.lastMatchedTurn = -1;
        this.counter = 0;
        this.futureComputed = false;
        this.last.fill(0);
    }

    protected add(
        r: number,
        x: number,
        y: number,
        z: number,
        maskr: BoolArray2DRow
    ) {
        maskr.set(x + y * this.grid.MX + z * this.grid.MX * this.grid.MY, true);

        const match: [number, number, number, number] = [r, x, y, z];
        if (this.matchCount < this.matches.length)
            this.matches[this.matchCount] = match;
        else this.matches.push(match);
        this.matchCount++;
    }

    public override run() {
        for (let r = 0; r < this.last.length; r++) this.last[r] = 0;

        if (this.steps > 0 && this.counter >= this.steps) return false;

        const grid = this.grid;
        const { MX, MY, MZ } = grid;
        if (this.observations && !this.futureComputed) {
            if (
                !Observation.computeFutureSetPresent(
                    this.future,
                    grid.state,
                    this.observations
                )
            )
                return false;
            else {
                this.futureComputed = true;
                if (this.search) {
                    this.trajectory = null;
                    const TRIES = this.limit < 0 ? 1 : 20;
                    for (let k = 0; k < TRIES && !this.trajectory; k++) {
                        const result = Search.run(
                            grid.state,
                            this.future,
                            this.rules,
                            grid.MX,
                            grid.MY,
                            grid.MZ,
                            grid.alphabet_size,
                            this instanceof AllNode,
                            this.limit,
                            this.depthCoefficient,
                            this.ip.rng.int32()
                        );
                        this.trajectory = Array2D.from(Uint8Array, result);
                    }
                    if (!this.trajectory) console.error("SEARCH RETURNED NULL");
                } else
                    Observation.computeBackwardPotentials(
                        this.potentials,
                        this.future,
                        MX,
                        MY,
                        MZ,
                        this.rules
                    );
            }
        }

        if (this.lastMatchedTurn >= 0) {
            const ip = this.ip;
            for (
                let n = ip.first[this.lastMatchedTurn];
                n < ip.changes.length;
                n++
            ) {
                const [x, y, z] = ip.changes[n];
                const value = grid.state[x + y * MX + z * MX * MY];
                for (let r = 0; r < this.rules.length; r++) {
                    const rule = this.rules[r];
                    const maskr = this.matchMask.row(r);
                    const shifts = rule.ishifts[value];
                    for (const [shiftx, shifty, shiftz] of shifts) {
                        const sx = x - shiftx;
                        const sy = y - shifty;
                        const sz = z - shiftz;

                        if (
                            sx < 0 ||
                            sy < 0 ||
                            sz < 0 ||
                            sx + rule.IMX > MX ||
                            sy + rule.IMY > MY ||
                            sz + rule.IMZ > MZ
                        )
                            continue;
                        const si = sx + sy * MX + sz * MX * MY;

                        if (!maskr.get(si) && grid.matches(rule, sx, sy, sz))
                            this.add(r, sx, sy, sz, maskr);
                    }
                }
            }
        } else {
            this.matchCount = 0;
            for (let r = 0; r < this.rules.length; r++) {
                const rule = this.rules[r];
                const maskr = this.matchMask?.row(r);
                for (let z = rule.IMZ - 1; z < MZ; z += rule.IMZ)
                    for (let y = rule.IMY - 1; y < MY; y += rule.IMY)
                        for (let x = rule.IMX - 1; x < MX; x += rule.IMX) {
                            var shifts =
                                rule.ishifts[
                                    grid.state[x + y * MX + z * MX * MY]
                                ];
                            for (const [shiftx, shifty, shiftz] of shifts) {
                                const sx = x - shiftx;
                                const sy = y - shifty;
                                const sz = z - shiftz;
                                if (
                                    sx < 0 ||
                                    sy < 0 ||
                                    sz < 0 ||
                                    sx + rule.IMX > MX ||
                                    sy + rule.IMY > MY ||
                                    sz + rule.IMZ > MZ
                                )
                                    continue;

                                if (grid.matches(rule, sx, sy, sz))
                                    this.add(r, sx, sy, sz, maskr);
                            }
                        }
            }
        }

        if (this.fields) {
            let anysuccess = false,
                anycomputation = false;
            for (let c = 0; c < this.fields.length; c++) {
                const field = this.fields[c];
                if (field && (this.counter === 0 || field.recompute)) {
                    // TODO: make sure this is right
                    const success = field.compute(this.potentials.row(c), grid);
                    if (!success && field.essential) return false;
                    anysuccess ||= success;
                    anycomputation = true;
                }
            }
            if (anycomputation && !anysuccess) return false;
        }

        return true;
    }
}
