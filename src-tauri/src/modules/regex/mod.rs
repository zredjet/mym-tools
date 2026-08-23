use crate::module::ModuleBackend;
pub struct RegexModule;
impl ModuleBackend for RegexModule {
    fn id(&self) -> &'static str {
        "regex"
    }
    fn is_stateless(&self) -> bool {
        true
    }
}
